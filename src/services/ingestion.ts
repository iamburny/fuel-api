import { prisma } from "../db";
import { fuelFinderClient } from "./fuelFinderClient";
import { evaluateAlerts, PriceDrop } from "./alerts";

// Fuel type identifiers are passed through from the upstream API as-is:
// E10, E5, B7_Standard, B7_Premium, B10, HVO.

// ── Station ingestion ────────────────────────────────

async function ingestStations(): Promise<void> {
  let rawStations: any[];
  try {
    rawStations = await fuelFinderClient.fetchStations();
  } catch (err: any) {
    await prisma.apiCallLog.create({
      data: { endpoint: "/api/v1/pfs", recordsReturned: 0, success: false, errorMessage: err.message },
    });
    throw err;
  }

  // Audit log
  await prisma.apiCallLog.create({
    data: { endpoint: "/api/v1/pfs", recordsReturned: rawStations.length, success: true },
  });

  let skippedNoLocation = 0;
  let skippedClosed = 0;

  for (const s of rawStations) {
    const govId = s.node_id;
    if (!govId) continue;

    // Drop permanently closed forecourts — they pollute geo queries.
    if (s.permanent_closure === true) {
      skippedClosed++;
      continue;
    }

    const loc = s.location ?? {};
    const lat = Number(loc.latitude);
    const lng = Number(loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      skippedNoLocation++;
      continue;
    }

    const fields = {
      name: s.trading_name ?? "Unknown",
      brand: s.brand_name ?? null,
      operator: null,
      phone: s.public_phone_number ?? null,
      temporaryClosure: s.temporary_closure === true,
      isMotorway: s.is_motorway_service_station === true,
      isSupermarket: s.is_supermarket_service_station === true,
      addressLine1: loc.address_line_1 ?? null,
      addressLine2: loc.address_line_2 ?? null,
      town: loc.city ?? null,
      county: loc.county ?? null,
      postcode: loc.postcode ?? null,
      latitude: lat,
      longitude: lng,
      amenities: JSON.stringify(s.amenities ?? {}),
      openingHours: JSON.stringify(s.opening_times ?? {}),
      lastUpdated: new Date(),
    };

    await prisma.station.upsert({
      where: { govId },
      create: { govId, ...fields },
      update: fields,
    });
  }

  console.log(
    `[Ingestion] Station ingestion complete: ${rawStations.length} records, ` +
      `${skippedClosed} permanently closed, ${skippedNoLocation} without location`
  );
}

// ── Price ingestion ──────────────────────────────────

async function ingestPrices(): Promise<PriceDrop[]> {
  let rawPrices: any[];
  try {
    rawPrices = await fuelFinderClient.fetchFuelPrices();
  } catch (err: any) {
    await prisma.apiCallLog.create({
      data: { endpoint: "/api/v1/pfs/fuel-prices", recordsReturned: 0, success: false, errorMessage: err.message },
    });
    throw err;
  }

  // Audit log
  await prisma.apiCallLog.create({
    data: { endpoint: "/api/v1/pfs/fuel-prices", recordsReturned: rawPrices.length, success: true },
  });

  // Build govId → station.id lookup
  const stations = await prisma.station.findMany({ select: { id: true, govId: true } });
  const govToId = new Map(stations.map((s) => [s.govId, s.id]));

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // (station, fuelType) pairs that already have a price_history row from today — from either
  // a genuine change or an earlier snapshot this cycle — so an unchanged price only gets one
  // extra "still this price" row per day rather than one every poll.
  const snapshottedToday = await prisma.priceHistory.findMany({
    where: { fetchedAt: { gte: todayStart } },
    select: { stationId: true, fuelType: true },
  });
  const snapshottedTodayKeys = new Set(snapshottedToday.map((r) => `${r.stationId}:${r.fuelType}`));

  let newPrices = 0;
  let historyRows = 0;
  let dailySnapshots = 0;
  // Confirmed price drops this cycle (new < old) — fanned out to area/favourite alerts after.
  const drops: PriceDrop[] = [];

  for (const record of rawPrices) {
    const govId = record.node_id;
    if (!govId) continue;
    const stationId = govToId.get(govId);
    if (!stationId) continue;

    const entries: any[] = record.fuel_prices ?? [];

    for (const entry of entries) {
      const fuelType = entry.fuel_type;
      if (!fuelType) continue;
      const price = Number(entry.price);
      if (!Number.isFinite(price) || price < 100 || price > 500) continue;

      // price_last_updated = when the trader reported the change
      // price_change_effective_timestamp = when the new price took effect
      const reportedRaw = entry.price_last_updated ?? entry.price_change_effective_timestamp;
      const reportedAt = reportedRaw ? new Date(reportedRaw) : now;

      // Upsert current price
      const existing = await prisma.fuelPrice.findUnique({
        where: { stationId_fuelType: { stationId, fuelType } },
      });

      const key = `${stationId}:${fuelType}`;

      if (existing) {
        if (existing.pricePence !== price) {
          await prisma.fuelPrice.update({
            where: { id: existing.id },
            data: { pricePence: price, reportedAt, fetchedAt: now },
          });
          await prisma.priceHistory.create({
            data: { stationId, fuelType, pricePence: price, reportedAt, fetchedAt: now },
          });
          snapshottedTodayKeys.add(key);
          historyRows++;
          if (price < existing.pricePence) {
            drops.push({ stationId, fuelType, newPence: price });
          }
        } else if (!snapshottedTodayKeys.has(key)) {
          // Price hasn't moved, but nothing's been recorded for this station+fuel today yet —
          // write a same-price snapshot so the trend chart gets at least one point per day
          // instead of gaps as long as the price stays put. Stamped with `now`, not the
          // (possibly weeks-old) upstream reportedAt, since this row means "still this price
          // as of today", not a new report from the trader.
          await prisma.priceHistory.create({
            data: { stationId, fuelType, pricePence: price, reportedAt: now, fetchedAt: now },
          });
          snapshottedTodayKeys.add(key);
          historyRows++;
          dailySnapshots++;
        }
      } else {
        await prisma.fuelPrice.create({
          data: { stationId, fuelType, pricePence: price, reportedAt, fetchedAt: now },
        });
        await prisma.priceHistory.create({
          data: { stationId, fuelType, pricePence: price, reportedAt, fetchedAt: now },
        });
        snapshottedTodayKeys.add(key);
        newPrices++;
        historyRows++;
      }
    }
  }

  console.log(
    `[Ingestion] Price ingestion complete: ${rawPrices.length} raw, ${newPrices} new, ${historyRows} history rows (${dailySnapshots} daily snapshots), ${drops.length} drops`
  );
  return drops;
}

// ── Full cycle ───────────────────────────────────────

export async function runFullIngestion(): Promise<void> {
  console.log("[Ingestion] Starting full ingestion cycle");
  try {
    await ingestStations();
    const drops = await ingestPrices();
    const { areaSent, favouriteSent } = await evaluateAlerts(drops);
    if (areaSent || favouriteSent) {
      console.log(`[Ingestion] Alerts sent: ${areaSent} area, ${favouriteSent} favourite`);
    }
    console.log("[Ingestion] Cycle complete");
  } catch (err) {
    console.error("[Ingestion] Cycle failed:", err);
  }
}
