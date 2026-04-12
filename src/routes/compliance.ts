import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { env } from "../config";

const router = Router();

/** GET /api/admin/compliance/stats — today's API usage vs Fair Use Policy */
router.get("/stats", async (_req: Request, res: Response) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const totalCalls = await prisma.apiCallLog.count({
    where: { calledAt: { gte: todayStart }, success: true },
  });

  const minutesElapsed = (Date.now() - todayStart.getTime()) / 60_000;
  const avgInterval = totalCalls > 0 ? Math.round((minutesElapsed / totalCalls) * 100) / 100 : null;

  // Compliant if avg interval ≤ 5 min (polling at least every 5 min)
  const compliant = avgInterval !== null && avgInterval <= 5.5;

  res.json({
    total_api_calls_today: totalCalls,
    avg_interval_minutes: avgInterval,
    compliant,
    discrepancy_report_url: env.DISCREPANCY_REPORT_URL,
  });
});

/** GET /api/admin/compliance/call-log — recent API call audit log */
router.get("/call-log", async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const since = new Date(Date.now() - days * 86_400_000);

  const logs = await prisma.apiCallLog.findMany({
    where: { calledAt: { gte: since } },
    orderBy: { calledAt: "desc" },
    take: 500,
  });

  res.json(
    logs.map((l) => ({
      id: l.id,
      endpoint: l.endpoint,
      called_at: l.calledAt,
      records_returned: l.recordsReturned,
      success: l.success,
      error_message: l.errorMessage,
    }))
  );
});

export default router;
