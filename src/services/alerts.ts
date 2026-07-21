import { prisma } from "../db";
import { haversine } from "./geo";
import { sendPriceDropNotification } from "./fcm";

/**
 * A price that fell during ingestion. Emitted by ingestPrices() when an existing FuelPrice is
 * updated to a lower value — the one point in the system that knows old-vs-new.
 */
export interface PriceDrop {
  stationId: number;
  fuelType: string;
  newPence: number;
}

/**
 * Fan a batch of confirmed price drops out to the users who should hear about them:
 *  - Area subscriptions: any AlertSubscription (notify=true, matching fuel type) whose point is
 *    within radius of the dropped station. Throttled via lastNotifiedPence so a station sitting
 *    at a low price doesn't re-notify every ingestion cycle.
 *  - Per-station favourites: Favourite rows with notifyOnDrop for that exact station+fuel, honouring
 *    an optional price threshold. This is what finally makes the long-dormant favourite alerts fire.
 *
 * FCM is a no-op when unconfigured (dev/test), so this is safe to call unconditionally after every
 * ingestion cycle. Returns per-channel counts of pushes actually dispatched.
 */
export async function evaluateAlerts(
  drops: PriceDrop[]
): Promise<{ areaSent: number; favouriteSent: number }> {
  if (drops.length === 0) return { areaSent: 0, favouriteSent: 0 };

  const stationIds = [...new Set(drops.map((d) => d.stationId))];
  const fuelTypes = [...new Set(drops.map((d) => d.fuelType))];

  const stations = await prisma.station.findMany({ where: { id: { in: stationIds } } });
  const stationById = new Map(stations.map((s) => [s.id, s]));

  let areaSent = 0;
  let favouriteSent = 0;

  // ── Area subscriptions ──────────────────────────────────
  const subs = await prisma.alertSubscription.findMany({
    where: { notify: true, fuelType: { in: fuelTypes } },
    include: { user: { select: { fcmToken: true } } },
  });

  for (const drop of drops) {
    const station = stationById.get(drop.stationId);
    if (!station) continue;
    for (const sub of subs) {
      if (sub.fuelType !== drop.fuelType) continue;
      // Only notify when this beats the last price we alerted this subscription about.
      if (sub.lastNotifiedPence != null && drop.newPence >= sub.lastNotifiedPence) continue;
      if (haversine(sub.latitude, sub.longitude, station.latitude, station.longitude) > sub.radiusMiles) {
        continue;
      }

      const result = await sendPriceDropNotification(sub.user.fcmToken, {
        stationId: station.id,
        stationName: station.name,
        fuelType: drop.fuelType,
        pricePence: drop.newPence,
      });
      if (result.sent) {
        areaSent++;
        await prisma.alertSubscription.update({
          where: { id: sub.id },
          data: { lastNotifiedPence: drop.newPence },
        });
      }
    }
  }

  // ── Per-station favourite alerts ─────────────────────────
  const favourites = await prisma.favourite.findMany({
    where: { notifyOnDrop: true, stationId: { in: stationIds }, fuelType: { in: fuelTypes } },
    include: { station: { select: { name: true } }, user: { select: { fcmToken: true } } },
  });

  for (const drop of drops) {
    for (const fav of favourites) {
      if (fav.stationId !== drop.stationId || fav.fuelType !== drop.fuelType) continue;
      if (fav.priceThresholdPence != null && drop.newPence > fav.priceThresholdPence) continue;

      const result = await sendPriceDropNotification(fav.user.fcmToken, {
        stationId: drop.stationId,
        stationName: fav.station?.name ?? "Station",
        fuelType: drop.fuelType,
        pricePence: drop.newPence,
      });
      if (result.sent) favouriteSent++;
    }
  }

  return { areaSent, favouriteSent };
}
