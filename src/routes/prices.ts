import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { findCheapest } from "../services/geo";
import { complianceFooter } from "../services/compliance";
import { stationDto } from "../dto";

const router = Router();

/** GET /api/prices/cheapest */
router.get("/cheapest", async (req: Request, res: Response) => {
  const fuelType = (req.query.fuel_type as string) || "E10";
  const lat = req.query.lat ? Number(req.query.lat) : undefined;
  const lng = req.query.lng ? Number(req.query.lng) : undefined;
  const radius = Number(req.query.radius) || 10;
  const limit = Math.min(Number(req.query.limit) || 10, 500);

  const results = await findCheapest(fuelType, lat, lng, radius, limit);

  res.json({
    results: results.map((r) => ({
      station: stationDto(r.station),
      price_pence: r.price.pricePence,
      distance_miles: r.distanceMiles,
    })),
    ...complianceFooter(),
  });
});

/** GET /api/prices/averages — national stats per fuel type */
router.get("/averages", async (req: Request, res: Response) => {
  const groups = await prisma.fuelPrice.groupBy({
    by: ["fuelType"],
    _avg: { pricePence: true },
    _min: { pricePence: true },
    _max: { pricePence: true },
    _count: { id: true },
  });

  res.json({
    averages: groups.map((g) => ({
      fuel_type: g.fuelType,
      avg_price_pence: Math.round((g._avg.pricePence ?? 0) * 100) / 100,
      min_price_pence: g._min.pricePence ?? 0,
      max_price_pence: g._max.pricePence ?? 0,
      station_count: g._count.id,
      as_of: new Date().toISOString(),
    })),
    ...complianceFooter(),
  });
});

/** GET /api/prices/history/:stationId — price history for a station */
router.get("/history/:stationId", async (req: Request, res: Response) => {
  const stationId = Number(req.params.stationId);
  const fuelType = (req.query.fuel_type as string) || "E10";
  const days = Math.min(Number(req.query.days) || 30, 365);

  const station = await prisma.station.findUnique({ where: { id: stationId } });
  if (!station) {
    res.status(404).json({ detail: "Station not found" });
    return;
  }

  const since = new Date(Date.now() - days * 86_400_000);

  const history = await prisma.priceHistory.findMany({
    where: { stationId, fuelType, reportedAt: { gte: since } },
    orderBy: { reportedAt: "asc" },
  });

  res.json({
    station_id: stationId,
    station_name: station.name,
    fuel_type: fuelType,
    history: history.map((h) => ({
      price_pence: h.pricePence,
      reported_at: h.reportedAt,
    })),
  });
});

/** GET /api/prices/trends — daily national average over time */
router.get("/trends", async (req: Request, res: Response) => {
  const fuelType = (req.query.fuel_type as string) || "E10";
  const days = Math.min(Number(req.query.days) || 30, 365);
  const since = new Date(Date.now() - days * 86_400_000);

  // Prisma doesn't support date grouping natively — fetch and aggregate in JS
  const rows = await prisma.priceHistory.findMany({
    where: { fuelType, reportedAt: { gte: since } },
    orderBy: { reportedAt: "asc" },
    select: { pricePence: true, reportedAt: true },
  });

  // Group by date string
  const byDate = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.reportedAt.toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(r.pricePence);
  }

  const trend = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, prices]) => ({
      date,
      avg_price_pence: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
      min_price_pence: Math.min(...prices),
      max_price_pence: Math.max(...prices),
      observations: prices.length,
    }));

  res.json({ trend, ...complianceFooter() });
});

export default router;
