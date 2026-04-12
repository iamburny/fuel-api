import { prisma } from "../db";
import { fuelFinderClient } from "./fuelFinderClient";

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

async function ingestPrices(): Promise<void> {
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
  let newPrices = 0;
  let historyRows = 0;

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

      if (existing) {
        if (existing.pricePence !== price) {
          await prisma.fuelPrice.update({
            where: { id: existing.id },
            data: { pricePence: price, reportedAt, fetchedAt: now },
          });
          await prisma.priceHistory.create({
            data: { stationId, fuelType, pricePence: price, reportedAt, fetchedAt: now },
          });
          historyRows++;
        }
      } else {
        await prisma.fuelPrice.create({
          data: { stationId, fuelType, pricePence: price, reportedAt, fetchedAt: now },
        });
        await prisma.priceHistory.create({
          data: { stationId, fuelType, pricePence: price, reportedAt, fetchedAt: now },
        });
        newPrices++;
        historyRows++;
      }
    }
  }

  console.log(
    `[Ingestion] Price ingestion complete: ${rawPrices.length} raw, ${newPrices} new, ${historyRows} history rows`
  );
}

// ── Full cycle ───────────────────────────────────────

export async function runFullIngestion(): Promise<void> {
  console.log("[Ingestion] Starting full ingestion cycle");
  try {
    await ingestStations();
    await ingestPrices();
    console.log("[Ingestion] Cycle complete");
  } catch (err) {
    console.error("[Ingestion] Cycle failed:", err);
  }
}
