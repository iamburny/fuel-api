import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { env } from "../config";

const router = Router();

/** GET /api/discrepancy/report-url — official Gov discrepancy report link */
router.get("/report-url", (_req: Request, res: Response) => {
  res.json({
    url: env.DISCREPANCY_REPORT_URL,
    message: "Report incorrect fuel prices directly to the Government Fuel Finder service.",
  });
});

/** POST /api/discrepancy — submit a discrepancy report */
router.post("/", async (req: Request, res: Response) => {
  const { station_id, fuel_type, reported_price_pence, expected_price_pence, description, reporter_email } =
    req.body;

  if (!description) {
    res.status(400).json({ detail: "description is required" });
    return;
  }

  if (station_id) {
    const station = await prisma.station.findUnique({ where: { id: station_id } });
    if (!station) {
      res.status(404).json({ detail: "Station not found" });
      return;
    }
  }

  const report = await prisma.discrepancyReport.create({
    data: {
      stationId: station_id ?? null,
      fuelType: fuel_type ?? null,
      reportedPricePence: reported_price_pence ?? null,
      expectedPricePence: expected_price_pence ?? null,
      description,
      reporterEmail: reporter_email ?? null,
    },
  });

  res.status(201).json({
    id: report.id,
    station_id: report.stationId,
    description: report.description,
    forwarded_to_aggregator: report.forwardedToAggregator,
    created_at: report.createdAt,
  });
});

/** GET /api/discrepancy — list recent reports (admin) */
router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const reports = await prisma.discrepancyReport.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(
    reports.map((r) => ({
      id: r.id,
      station_id: r.stationId,
      description: r.description,
      forwarded_to_aggregator: r.forwardedToAggregator,
      created_at: r.createdAt,
    }))
  );
});

export default router;
