import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { env } from "../config";
import { runFullIngestion } from "../services/ingestion";
import { createToken } from "../services/auth";
import { sendPriceDropNotification, isFcmEnabled } from "../services/fcm";
import { stationDto, priceDto } from "../dto";
import { API_ENDPOINT_CATALOG } from "../services/endpointCatalog";

/**
 * Admin/operations console API. Every route here is mounted behind `requireAdmin`
 * (JWT + role="admin") in app.ts, so handlers can assume an authenticated admin.
 *
 * Response bodies use snake_case to match the rest of the public API (see dto.ts).
 */
const router = Router();

// ── Helpers ──────────────────────────────────────────

/** Parse ?page & ?page_size into a bounded skip/take. */
function pagination(req: Request, defaultSize = 25, maxSize = 200) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(Math.max(1, Number(req.query.page_size) || defaultSize), maxSize);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function idParam(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ── Monitoring & health ──────────────────────────────

/** GET /api/admin/overview — headline counts + ingestion + data-freshness. */
router.get("/overview", async (_req: Request, res: Response) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [stations, prices, users, favourites, openDiscrepancies, lastCall, freshest, callsToday] =
    await Promise.all([
      prisma.station.count(),
      prisma.fuelPrice.count(),
      prisma.user.count(),
      prisma.favourite.count(),
      prisma.discrepancyReport.count({ where: { resolvedAt: null } }),
      prisma.apiCallLog.findFirst({ orderBy: { calledAt: "desc" } }),
      prisma.fuelPrice.aggregate({ _max: { fetchedAt: true } }),
      prisma.apiCallLog.count({ where: { calledAt: { gte: todayStart }, success: true } }),
    ]);

  const freshestAt = freshest._max.fetchedAt;
  const ageMinutes = freshestAt ? Math.round((Date.now() - freshestAt.getTime()) / 60_000) : null;

  res.json({
    counts: {
      stations,
      prices,
      users,
      favourites,
      open_discrepancies: openDiscrepancies,
    },
    ingestion: {
      last_call_at: lastCall?.calledAt ?? null,
      last_call_endpoint: lastCall?.endpoint ?? null,
      last_call_success: lastCall?.success ?? null,
      last_call_error: lastCall?.errorMessage ?? null,
      successful_calls_today: callsToday,
    },
    data_freshness: {
      latest_price_fetched_at: freshestAt,
      age_minutes: ageMinutes,
      // Prices should refresh at least every poll interval; flag if well past it.
      stale: ageMinutes !== null && ageMinutes > env.POLL_INTERVAL_MINUTES * 3,
    },
    poll_interval_minutes: env.POLL_INTERVAL_MINUTES,
    fcm_enabled: isFcmEnabled(),
  });
});

/** GET /api/admin/health — deep health: DB reachability + data freshness. */
router.get("/health", async (_req: Request, res: Response) => {
  let dbOk = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbOk = false;
  }
  const freshest = await prisma.fuelPrice.aggregate({ _max: { fetchedAt: true } });
  const freshestAt = freshest._max.fetchedAt;
  const ageMinutes = freshestAt ? Math.round((Date.now() - freshestAt.getTime()) / 60_000) : null;

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    db_ok: dbOk,
    latest_price_fetched_at: freshestAt,
    data_age_minutes: ageMinutes,
    poll_interval_minutes: env.POLL_INTERVAL_MINUTES,
  });
});

/** GET /api/admin/ingestion/log?days= — audit log + per-day/per-endpoint rollups. */
router.get("/ingestion/log", async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 7, 90);
  const since = new Date(Date.now() - days * 86_400_000);

  const logs = await prisma.apiCallLog.findMany({
    where: { calledAt: { gte: since } },
    orderBy: { calledAt: "desc" },
    take: 500,
  });

  // Rollups computed in-process (small result set).
  const byEndpoint: Record<string, { success: number; failure: number; records: number }> = {};
  const byDay: Record<string, { success: number; failure: number }> = {};
  for (const l of logs) {
    const ep = (byEndpoint[l.endpoint] ??= { success: 0, failure: 0, records: 0 });
    l.success ? ep.success++ : ep.failure++;
    ep.records += l.recordsReturned;

    const day = l.calledAt.toISOString().slice(0, 10);
    const d = (byDay[day] ??= { success: 0, failure: 0 });
    l.success ? d.success++ : d.failure++;
  }

  res.json({
    logs: logs.map((l) => ({
      id: l.id,
      endpoint: l.endpoint,
      called_at: l.calledAt,
      records_returned: l.recordsReturned,
      success: l.success,
      error_message: l.errorMessage,
    })),
    by_endpoint: byEndpoint,
    by_day: byDay,
  });
});

/** POST /api/admin/ingestion/run — trigger a full ingestion cycle (JWT-gated). */
router.post("/ingestion/run", async (_req: Request, res: Response) => {
  await runFullIngestion();
  res.json({ status: "ingestion_complete" });
});

// ── Stations ─────────────────────────────────────────

/** GET /api/admin/stations?q=&page=&page_size= */
router.get("/stations", async (req: Request, res: Response) => {
  const { page, pageSize, skip, take } = pagination(req);
  const q = (req.query.q as string | undefined)?.trim();

  const where = q
    ? {
        OR: [
          { name: { contains: q } },
          { postcode: { contains: q } },
          { brand: { contains: q } },
          { town: { contains: q } },
        ],
      }
    : {};

  const [total, stations] = await Promise.all([
    prisma.station.count({ where }),
    prisma.station.findMany({ where, orderBy: { name: "asc" }, skip, take, include: { prices: true } }),
  ]);

  res.json({
    items: stations.map((s) => ({ ...stationDto(s), prices: s.prices.map(priceDto) })),
    total,
    page,
    page_size: pageSize,
  });
});

/** GET /api/admin/stations/:id — full detail with prices + recent history + discrepancies. */
router.get("/stations/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });

  const station = await prisma.station.findUnique({
    where: { id },
    include: {
      prices: true,
      priceHistory: { orderBy: { reportedAt: "desc" }, take: 100 },
      discrepancies: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!station) return res.status(404).json({ detail: "Station not found" });

  res.json({
    ...stationDto(station),
    prices: station.prices.map(priceDto),
    price_history: station.priceHistory.map(priceDto),
    discrepancies: station.discrepancies.map((d) => ({
      id: d.id,
      description: d.description,
      created_at: d.createdAt,
      resolved_at: d.resolvedAt,
    })),
  });
});

/**
 * PATCH /api/admin/stations/:id — edit editable station metadata.
 * Deliberately does NOT allow editing Gov-sourced prices (compliance: prices
 * must be shown unmodified). Only descriptive/status fields are editable.
 */
router.patch("/stations/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });

  const allowed = ["name", "brand", "operator", "phone", "temporaryClosure", "isMotorway", "isSupermarket"];
  const data: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in req.body) data[key] = req.body[key];
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ detail: "No editable fields supplied" });
  }

  try {
    const station = await prisma.station.update({ where: { id }, data });
    res.json(stationDto(station));
  } catch {
    res.status(404).json({ detail: "Station not found" });
  }
});

/** DELETE /api/admin/stations/:id — remove a station (cascades prices/history/favourites). */
router.delete("/stations/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });
  try {
    await prisma.station.delete({ where: { id } });
    res.json({ status: "deleted", id });
  } catch {
    res.status(404).json({ detail: "Station not found" });
  }
});

// ── Prices ───────────────────────────────────────────

/** GET /api/admin/prices?fuel_type=&station_id=&page= — current prices explorer. */
router.get("/prices", async (req: Request, res: Response) => {
  const { page, pageSize, skip, take } = pagination(req);
  const fuelType = req.query.fuel_type as string | undefined;
  const stationId = req.query.station_id ? Number(req.query.station_id) : undefined;

  const where = {
    ...(fuelType ? { fuelType } : {}),
    ...(stationId ? { stationId } : {}),
  };

  const [total, prices] = await Promise.all([
    prisma.fuelPrice.count({ where }),
    prisma.fuelPrice.findMany({
      where,
      orderBy: { pricePence: "asc" },
      skip,
      take,
      include: { station: { select: { id: true, name: true, brand: true, postcode: true } } },
    }),
  ]);

  res.json({
    items: prices.map((p) => ({
      id: p.id,
      station_id: p.stationId,
      station_name: p.station.name,
      station_brand: p.station.brand,
      station_postcode: p.station.postcode,
      fuel_type: p.fuelType,
      price_pence: p.pricePence,
      reported_at: p.reportedAt,
      fetched_at: p.fetchedAt,
    })),
    total,
    page,
    page_size: pageSize,
  });
});

/** GET /api/admin/prices/:stationId/history?fuel_type=&days= */
router.get("/prices/:stationId/history", async (req: Request, res: Response) => {
  const stationId = Number(req.params.stationId);
  if (!Number.isInteger(stationId)) return res.status(400).json({ detail: "Invalid station id" });

  const fuelType = req.query.fuel_type as string | undefined;
  const days = req.query.days === "all" ? null : Math.min(Number(req.query.days) || 30, 365);
  const since = days ? new Date(Date.now() - days * 86_400_000) : undefined;

  const history = await prisma.priceHistory.findMany({
    where: {
      stationId,
      ...(fuelType ? { fuelType } : {}),
      ...(since ? { reportedAt: { gte: since } } : {}),
    },
    orderBy: { reportedAt: "asc" },
  });

  res.json(history.map(priceDto));
});

// ── Discrepancies ────────────────────────────────────

/** GET /api/admin/discrepancies?status=open|resolved|all */
router.get("/discrepancies", async (req: Request, res: Response) => {
  const { page, pageSize, skip, take } = pagination(req);
  const status = (req.query.status as string) || "all";
  const where =
    status === "open"
      ? { resolvedAt: null }
      : status === "resolved"
        ? { resolvedAt: { not: null } }
        : {};

  const [total, reports] = await Promise.all([
    prisma.discrepancyReport.count({ where }),
    prisma.discrepancyReport.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
  ]);

  res.json({
    items: reports.map((r) => ({
      id: r.id,
      station_id: r.stationId,
      fuel_type: r.fuelType,
      reported_price_pence: r.reportedPricePence,
      expected_price_pence: r.expectedPricePence,
      description: r.description,
      reporter_email: r.reporterEmail,
      forwarded_to_aggregator: r.forwardedToAggregator,
      created_at: r.createdAt,
      resolved_at: r.resolvedAt,
    })),
    total,
    page,
    page_size: pageSize,
  });
});

/** PATCH /api/admin/discrepancies/:id — resolve / mark forwarded. */
router.patch("/discrepancies/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });

  const data: Record<string, unknown> = {};
  if ("resolved" in req.body) data.resolvedAt = req.body.resolved ? new Date() : null;
  if ("forwarded_to_aggregator" in req.body) data.forwardedToAggregator = Boolean(req.body.forwarded_to_aggregator);
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ detail: "Nothing to update (send `resolved` or `forwarded_to_aggregator`)" });
  }

  try {
    const r = await prisma.discrepancyReport.update({ where: { id }, data });
    res.json({
      id: r.id,
      forwarded_to_aggregator: r.forwardedToAggregator,
      resolved_at: r.resolvedAt,
    });
  } catch {
    res.status(404).json({ detail: "Report not found" });
  }
});

// ── User administration ──────────────────────────────

function userDto(u: any) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    display_name: u.displayName ?? null,
    avatar_url: u.avatarUrl ?? null,
    auth_provider: u.authProvider ?? "password",
    google_linked: Boolean(u.googleSub),
    has_fcm_token: Boolean(u.fcmToken),
    created_at: u.createdAt,
    last_login_at: u.lastLoginAt,
  };
}

/** GET /api/admin/users?q=&page= */
router.get("/users", async (req: Request, res: Response) => {
  const { page, pageSize, skip, take } = pagination(req);
  const q = (req.query.q as string | undefined)?.trim();
  const where = q ? { email: { contains: q } } : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: { _count: { select: { favourites: true } } },
    }),
  ]);

  res.json({
    items: users.map((u) => ({ ...userDto(u), favourites_count: u._count.favourites })),
    total,
    page,
    page_size: pageSize,
  });
});

/** GET /api/admin/users/:id — detail with favourites. */
router.get("/users/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      favourites: {
        orderBy: { createdAt: "desc" },
        include: {
          station: {
            select: {
              id: true,
              name: true,
              postcode: true,
              prices: { select: { fuelType: true, pricePence: true } },
            },
          },
        },
      },
      alertSubscriptions: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!user) return res.status(404).json({ detail: "User not found" });

  res.json({
    ...userDto(user),
    favourites: user.favourites.map((f) => ({
      id: f.id,
      station_id: f.stationId,
      station_name: f.station.name,
      station_postcode: f.station.postcode,
      fuel_type: f.fuelType,
      notify_on_drop: f.notifyOnDrop,
      price_threshold_pence: f.priceThresholdPence,
      current_price_pence:
        f.station.prices.find((p) => p.fuelType === f.fuelType)?.pricePence ?? null,
      created_at: f.createdAt,
    })),
    alert_subscriptions: user.alertSubscriptions.map((a) => ({
      id: a.id,
      label: a.label,
      fuel_type: a.fuelType,
      radius_miles: a.radiusMiles,
      latitude: a.latitude,
      longitude: a.longitude,
      notify: a.notify,
      created_at: a.createdAt,
    })),
  });
});

/** PATCH /api/admin/users/:id — change role (and other safe fields). */
router.patch("/users/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });

  const data: Record<string, unknown> = {};
  if ("role" in req.body) {
    if (!["user", "admin"].includes(req.body.role)) {
      return res.status(400).json({ detail: "role must be 'user' or 'admin'" });
    }
    data.role = req.body.role;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ detail: "No editable fields supplied" });

  try {
    const user = await prisma.user.update({ where: { id }, data });
    res.json(userDto(user));
  } catch {
    res.status(404).json({ detail: "User not found" });
  }
});

/** DELETE /api/admin/users/:id — remove a user (cascades favourites). */
router.delete("/users/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });
  // Guard against an admin deleting themselves out of the console.
  if (id === (req as any).userId) return res.status(400).json({ detail: "Cannot delete your own account" });
  try {
    await prisma.user.delete({ where: { id } });
    res.json({ status: "deleted", id });
  } catch {
    res.status(404).json({ detail: "User not found" });
  }
});

/** DELETE /api/admin/favourites/:id — remove a favourite. */
router.delete("/favourites/:id", async (req: Request, res: Response) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ detail: "Invalid id" });
  try {
    await prisma.favourite.delete({ where: { id } });
    res.json({ status: "deleted", id });
  } catch {
    res.status(404).json({ detail: "Favourite not found" });
  }
});

// ── Notifications ────────────────────────────────────

/** POST /api/admin/notifications/test { user_id } — send a test push. */
router.post("/notifications/test", async (req: Request, res: Response) => {
  const userId = Number(req.body.user_id);
  if (!Number.isInteger(userId)) return res.status(400).json({ detail: "user_id is required" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ detail: "User not found" });

  const result = await sendPriceDropNotification(user.fcmToken, {
    stationId: 0,
    stationName: "Fuel Admin test",
    fuelType: "E10",
    pricePence: 139.9,
  });
  res.json(result);
});

/**
 * POST /api/admin/notifications/price-drop-run — evaluate favourites with
 * notify-on-drop and send a push where the current price is at/below the
 * user's threshold. This is the price-drop feature the schema was built for
 * but that nothing implemented. `?dry_run=1` reports matches without sending.
 */
router.post("/notifications/price-drop-run", async (req: Request, res: Response) => {
  const dryRun = req.query.dry_run === "1" || req.body?.dry_run === true;

  const favourites = await prisma.favourite.findMany({
    where: { notifyOnDrop: true, priceThresholdPence: { not: null } },
    include: {
      user: { select: { id: true, fcmToken: true } },
      station: { select: { id: true, name: true } },
    },
  });

  const results: any[] = [];
  for (const fav of favourites) {
    const price = await prisma.fuelPrice.findUnique({
      where: { stationId_fuelType: { stationId: fav.stationId, fuelType: fav.fuelType } },
    });
    if (!price || fav.priceThresholdPence == null || price.pricePence > fav.priceThresholdPence) continue;

    const payload = {
      stationId: fav.stationId,
      stationName: fav.station.name,
      fuelType: fav.fuelType,
      pricePence: price.pricePence,
    };
    const result = dryRun
      ? { sent: false, skipped: "dry_run" as const }
      : await sendPriceDropNotification(fav.user.fcmToken, payload);
    results.push({ user_id: fav.user.id, favourite_id: fav.id, ...payload, ...result });
  }

  res.json({
    dry_run: dryRun,
    matched: results.length,
    sent: results.filter((r) => r.sent).length,
    results,
  });
});

// ── API testing / debugging support ──────────────────

/** GET /api/admin/endpoints — machine-readable catalog for the API tester UI. */
router.get("/endpoints", (_req: Request, res: Response) => {
  res.json(API_ENDPOINT_CATALOG);
});

/**
 * POST /api/admin/impersonate/:userId — mint a short-lived user JWT so the
 * console can exercise normal (non-admin) endpoints "as" a given user.
 */
router.post("/impersonate/:userId", async (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ detail: "Invalid user id" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ detail: "User not found" });

  res.json({
    access_token: createToken(user.id, "15m"),
    token_type: "bearer",
    user: { id: user.id, email: user.email, role: user.role },
    expires_in_minutes: 15,
  });
});

export default router;
