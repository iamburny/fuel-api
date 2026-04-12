import { prisma } from "../db";

const EARTH_RADIUS_MILES = 3958.8;

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

export async function findNearbyStations(
  lat: number,
  lng: number,
  radiusMiles = 10,
  fuelType?: string,
  limit = 20
): Promise<NearbyResult[]> {
  const box = boundingBox(lat, lng, radiusMiles);

  const stations = await prisma.station.findMany({
    where: {
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLng, lte: box.maxLng },
    },
    include: {
      prices: fuelType ? { where: { fuelType } } : true,
    },
  });

  // Calculate distance and filter by actual radius
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

export async function findCheapest(
  fuelType = "E10",
  lat?: number,
  lng?: number,
  radiusMiles = 10,
  limit = 10
) {
  let where: any = { fuelType };

  // If location provided, filter by bounding box first
  if (lat != null && lng != null) {
    const box = boundingBox(lat, lng, radiusMiles);
    where = {
      fuelType,
      station: {
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng },
      },
    };
  }

  const prices = await prisma.fuelPrice.findMany({
    where,
    orderBy: { pricePence: "asc" },
    take: limit * 2, // fetch extra to account for radius filtering
    include: { station: true },
  });

  let results = prices.map((p) => ({
    station: p.station,
    price: p,
    distanceMiles:
      lat != null && lng != null
        ? Math.round(haversine(lat, lng, p.station.latitude, p.station.longitude) * 100) / 100
        : null,
  }));

  // Exact radius filter
  if (lat != null && lng != null) {
    results = results.filter((r) => r.distanceMiles! <= radiusMiles);
  }

  return results.slice(0, limit);
}
