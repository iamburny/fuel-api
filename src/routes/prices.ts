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

/**
 * GET /api/prices/heatmap — geographic price heat map for a fuel type. Stations are bucketed into
 * square grid cells purely by their GPS coordinates (the free-text `county` field is too dirty to
 * group on), and each cell reports its average price and signed deviation from the national average.
 * Query: fuel_type (default E10), cell = grid size in degrees (default 0.4, clamped 0.1–1.0).
 *
 * Price lives on fuel_prices and coordinates on stations, so this joins + groups in SQL (Prisma's
 * groupBy can't bucket by a computed coordinate expression).
 */
router.get("/heatmap", async (req: Request, res: Response) => {
  const fuelType = (req.query.fuel_type as string) || "E10";
  const cell = Math.min(Math.max(Number(req.query.cell) || 0.4, 0.1), 1.0);

  interface CellRow {
    avg_price_pence: number;
    station_count: number;
    // Marker position = mean of the cell's stations' own coordinates (nicer than the cell corner).
    latitude: number;
    longitude: number;
  }
  // Bin each station by CAST(coord / cell AS INTEGER). The exact bin boundary (truncate vs round,
  // which differs subtly between SQLite/Postgres) is irrelevant — binning is only for grouping, and
  // each cell's marker is placed at the mean of its stations' real coordinates.
  const rows = await prisma.$queryRaw<CellRow[]>(Prisma.sql`
    SELECT avg(fp.price_pence) AS avg_price_pence,
      count(*) AS station_count,
      avg(s.latitude) AS latitude,
      avg(s.longitude) AS longitude
    FROM fuel_prices fp
    JOIN stations s ON s.id = fp.station_id
    WHERE fp.fuel_type = ${fuelType}
    GROUP BY CAST(s.latitude / ${cell} AS INTEGER), CAST(s.longitude / ${cell} AS INTEGER)
  `);

  // National baseline = mean across every station reporting this fuel. Matches /averages.
  const natAgg = await prisma.fuelPrice.aggregate({
    where: { fuelType },
    _avg: { pricePence: true },
  });
  const nationalAvg = Math.round((natAgg._avg.pricePence ?? 0) * 100) / 100;

  const cells = rows.map((r) => {
    const avg = Math.round(Number(r.avg_price_pence) * 100) / 100;
    const delta = Math.round((avg - nationalAvg) * 100) / 100;
    return {
      avg_price_pence: avg,
      delta_pence: delta,
      delta_percent: nationalAvg ? Math.round((delta / nationalAvg) * 1000) / 10 : 0,
      station_count: Number(r.station_count),
      latitude: Math.round(Number(r.latitude) * 1e5) / 1e5,
      longitude: Math.round(Number(r.longitude) * 1e5) / 1e5,
    };
  });

  res.json({
    fuel_type: fuelType,
    national_avg_price_pence: nationalAvg,
    cell_size_degrees: cell,
    cells,
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
