import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { findNearbyStations, findStationsInBounds } from "../services/geo";
import { stationDto, priceDto } from "../dto";

const router = Router();

/** GET /api/stations/nearby — find stations near a location */
router.get("/nearby", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radius = Number(req.query.radius) || 10;
  const fuelType = (req.query.fuel_type as string) || undefined;
  const limit = Math.min(Number(req.query.limit) || 20, 500);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ detail: "lat and lng are required" });
    return;
  }

  const results = await findNearbyStations(lat, lng, radius, fuelType, limit);

  res.json({
    count: results.length,
    stations: results.map((r) => ({
      ...stationDto(r.station),
      distance_miles: r.distanceMiles,
      prices: r.prices.map(priceDto),
    })),
  });
});

/** GET /api/stations/bounds — stations within an exact lat/lng box (e.g. a map viewport) */
router.get("/bounds", async (req: Request, res: Response) => {
  const minLat = Number(req.query.minLat);
  const maxLat = Number(req.query.maxLat);
  const minLng = Number(req.query.minLng);
  const maxLng = Number(req.query.maxLng);
  const fuelType = (req.query.fuel_type as string) || undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  if ([minLat, maxLat, minLng, maxLng].some((v) => isNaN(v))) {
    res.status(400).json({ detail: "minLat, maxLat, minLng, and maxLng are required" });
    return;
  }

  const stations = await findStationsInBounds(minLat, maxLat, minLng, maxLng, fuelType, limit);

  res.json({
    count: stations.length,
    stations: stations.map((s) => ({
      ...stationDto(s),
      prices: s.prices.map(priceDto),
    })),
  });
});

/** GET /api/stations/search — search by name, postcode, or brand */
router.get("/search", async (req: Request, res: Response) => {
  const q = (req.query.q as string) || "";
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  if (q.length < 2) {
    res.status(400).json({ detail: "Query must be at least 2 characters" });
    return;
  }

  const stations = await prisma.station.findMany({
    where: {
      OR: [
        { name: { contains: q } },
        { postcode: { contains: q } },
        { brand: { contains: q } },
        { town: { contains: q } },
      ],
    },
    include: { prices: true },
    take: limit,
  });

  res.json({
    count: stations.length,
    stations: stations.map((s) => ({
      ...stationDto(s),
      prices: s.prices.map(priceDto),
    })),
  });
});

/** GET /api/stations/:id — station detail with current prices */
router.get("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const station = await prisma.station.findUnique({
    where: { id },
    include: { prices: true },
  });

  if (!station) {
    res.status(404).json({ detail: "Station not found" });
    return;
  }

  res.json({
    ...stationDto(station),
    prices: station.prices.map(priceDto),
  });
});

export default router;
