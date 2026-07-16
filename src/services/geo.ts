import { Prisma } from "@prisma/client";
import { prisma, isPostgres } from "../db";

const EARTH_RADIUS_MILES = 3958.8;
// Safety cap on SQLite dev's app-side haversine path — Prisma/SQLite can't compute distance in
// SQL (no trig functions), so a wide radius + dense area could otherwise pull unbounded rows
// before the JS filter/sort/slice. Not a concern at dev-fixture scale, but bounded regardless.
const SQLITE_CANDIDATE_CAP = 500;

/** Haversine distance in miles between two lat/lng points. */
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Rough bounding box for a radius (degrees). */
export function boundingBox(lat: number, lng: number, radiusMiles: number) {
  const dLat = radiusMiles / 69.0;
  const dLng = radiusMiles / (69.0 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: lng - dLng,
    maxLng: lng + dLng,
  };
}

export interface NearbyResult {
  station: any;
  distanceMiles: number;
  prices: any[];
}

/** Re-fetches full station rows (with prices) for the given ids, in the given order. */
async function stationsByIdInOrder(ids: number[], fuelType?: string) {
  if (ids.length === 0) return [];
  const stations = await prisma.station.findMany({
    where: { id: { in: ids } },
    include: { prices: fuelType ? { where: { fuelType } } : true },
  });
  const byId = new Map(stations.map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => s != null);
}

export async function findNearbyStations(
  lat: number,
  lng: number,
  radiusMiles = 10,
  fuelType?: string,
  limit = 20
): Promise<NearbyResult[]> {
  const box = boundingBox(lat, lng, radiusMiles);

  if (isPostgres()) {
    // Bounding box pre-filters using the indexed lat/lng columns; exact haversine distance and
    // ordering happen in SQL via a derived table (Postgres has the trig functions SQLite lacks).
    const rows = await prisma.$queryRaw<{ id: number; distance_miles: number }[]>(Prisma.sql`
      SELECT * FROM (
        SELECT id,
          ${EARTH_RADIUS_MILES} * 2 * asin(sqrt(
            power(sin(radians(${lat}::float8 - latitude) / 2), 2) +
            cos(radians(latitude)) * cos(radians(${lat}::float8)) *
              power(sin(radians(${lng}::float8 - longitude) / 2), 2)
          )) AS distance_miles
        FROM stations
        WHERE latitude BETWEEN ${box.minLat} AND ${box.maxLat}
          AND longitude BETWEEN ${box.minLng} AND ${box.maxLng}
      ) sub
      WHERE distance_miles <= ${radiusMiles}
      ORDER BY distance_miles ASC
      LIMIT ${limit}
    `);
    const distanceById = new Map(rows.map((r) => [r.id, r.distance_miles]));
    const stations = await stationsByIdInOrder(
      rows.map((r) => r.id),
      fuelType
    );
    return stations.map((s) => ({
      station: s,
      distanceMiles: Math.round((distanceById.get(s.id) ?? 0) * 100) / 100,
      prices: s.prices,
    }));
  }

  // SQLite dev path: no trig in SQL, so filter/sort/slice happens in JS — but capped so a wide
  // radius in dense fixture data can't pull an unbounded number of rows + price relations first.
  const stations = await prisma.station.findMany({
    where: {
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLng, lte: box.maxLng },
    },
    include: {
      prices: fuelType ? { where: { fuelType } } : true,
    },
    take: Math.min(Math.max(limit * 10, 100), SQLITE_CANDIDATE_CAP),
  });

  const results: NearbyResult[] = stations
    .map((s) => ({
      station: s,
      distanceMiles: Math.round(haversine(lat, lng, s.latitude, s.longitude) * 100) / 100,
      prices: s.prices,
    }))
    .filter((r) => r.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);

  return results;
}

/**
 * Stations within an exact lat/lng bounding box (e.g. a map viewport) — no radius or distance
 * involved, so no haversine step is needed on either dialect; a plain indexed range query with a
 * DB-side LIMIT is already correct and efficient.
 */
export async function findStationsInBounds(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  fuelType?: string,
  limit = 100
) {
  return prisma.station.findMany({
    where: {
      latitude: { gte: minLat, lte: maxLat },
      longitude: { gte: minLng, lte: maxLng },
    },
    include: {
      prices: fuelType ? { where: { fuelType } } : true,
    },
    take: limit,
  });
}

export async function findCheapest(
  fuelType = "E10",
  lat?: number,
  lng?: number,
  radiusMiles = 10,
  limit = 10
) {
  // No location: plain price-ordered query, no distance involved — already DB-side limited and
  // correct on both dialects.
  if (lat == null || lng == null) {
    const prices = await prisma.fuelPrice.findMany({
      where: { fuelType },
      orderBy: { pricePence: "asc" },
      take: limit,
      include: { station: true },
    });
    return prices.map((p) => ({ station: p.station, price: p, distanceMiles: null }));
  }

  const box = boundingBox(lat, lng, radiusMiles);

  if (isPostgres()) {
    // Single query: box pre-filter, exact haversine distance + radius filter, price-ordered,
    // DB-side limit — no over-fetch heuristic needed.
    const rows = await prisma.$queryRaw<{ price_id: number; distance_miles: number }[]>(
      Prisma.sql`
        SELECT * FROM (
          SELECT fp.id AS price_id,
            ${EARTH_RADIUS_MILES} * 2 * asin(sqrt(
              power(sin(radians(${lat}::float8 - s.latitude) / 2), 2) +
              cos(radians(s.latitude)) * cos(radians(${lat}::float8)) *
                power(sin(radians(${lng}::float8 - s.longitude) / 2), 2)
            )) AS distance_miles
          FROM fuel_prices fp
          JOIN stations s ON s.id = fp.station_id
          WHERE fp.fuel_type = ${fuelType}
            AND s.latitude BETWEEN ${box.minLat} AND ${box.maxLat}
            AND s.longitude BETWEEN ${box.minLng} AND ${box.maxLng}
        ) sub
        WHERE distance_miles <= ${radiusMiles}
        ORDER BY distance_miles ASC
        LIMIT ${limit}
      `
    );
    const distanceById = new Map(rows.map((r) => [r.price_id, r.distance_miles]));
    const ids = rows.map((r) => r.price_id);
    if (ids.length === 0) return [];
    const prices = await prisma.fuelPrice.findMany({
      where: { id: { in: ids } },
      include: { station: true },
    });
    const byId = new Map(prices.map((p) => [p.id, p]));
    return ids
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => p != null)
      .map((p) => ({
        station: p.station,
        price: p,
        distanceMiles: Math.round((distanceById.get(p.id) ?? 0) * 100) / 100,
      }));
  }

  // SQLite dev path: same capped-candidate approach as findNearbyStations, since there's no trig
  // in SQL to filter by exact radius before fetching.
  const prices = await prisma.fuelPrice.findMany({
    where: {
      fuelType,
      station: {
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng },
      },
    },
    orderBy: { pricePence: "asc" },
    take: Math.min(Math.max(limit * 10, 100), SQLITE_CANDIDATE_CAP),
    include: { station: true },
  });

  const results = prices
    .map((p) => ({
      station: p.station,
      price: p,
      distanceMiles: Math.round(haversine(lat, lng, p.station.latitude, p.station.longitude) * 100) / 100,
    }))
    .filter((r) => r.distanceMiles <= radiusMiles);

  return results.slice(0, limit);
}
