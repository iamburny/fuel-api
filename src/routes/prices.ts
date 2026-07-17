import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma, isPostgres } from "../db";
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
  // days=all returns the station's full history, unbounded by the usual 365-day cap — history can
  // (and often does, for a station whose price hasn't moved in a while) span further back than
  // that, so the normal day-range options can leave genuinely-existing older points unreachable.
  const isAllTime = req.query.days === "all";
  const since = isAllTime ? undefined : new Date(Date.now() - Math.min(Number(req.query.days) || 30, 365) * 86_400_000);

  const station = await prisma.station.findUnique({ where: { id: stationId } });
  if (!station) {
    res.status(404).json({ detail: "Station not found" });
    return;
  }

  const history = await prisma.priceHistory.findMany({
    where: { stationId, fuelType, ...(since ? { reportedAt: { gte: since } } : {}) },
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

  // Date-group aggregation happens in SQL (Prisma's groupBy can't group by a truncated date
  // expression) — this returns one row per day, not one row per observation, regardless of how
  // large price_history grows.
  interface TrendRow {
    date: string;
    avg_price_pence: number;
    min_price_pence: number;
    max_price_pence: number;
    observations: number;
  }
  const dateExpr = isPostgres()
    ? Prisma.sql`to_char(reported_at, 'YYYY-MM-DD')`
    : Prisma.sql`strftime('%Y-%m-%d', reported_at)`;
  const rows = await prisma.$queryRaw<TrendRow[]>(Prisma.sql`
    SELECT ${dateExpr} AS date,
      avg(price_pence) AS avg_price_pence,
      min(price_pence) AS min_price_pence,
      max(price_pence) AS max_price_pence,
      count(*) AS observations
    FROM price_history
    WHERE fuel_type = ${fuelType} AND reported_at >= ${since}
    GROUP BY date
    ORDER BY date ASC
  `);

  const trend = rows.map((r) => ({
    date: r.date,
    avg_price_pence: Math.round(Number(r.avg_price_pence) * 100) / 100,
    min_price_pence: Number(r.min_price_pence),
    max_price_pence: Number(r.max_price_pence),
    observations: Number(r.observations),
  }));

  res.json({ trend, ...complianceFooter() });
});

export default router;
