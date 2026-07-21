import express, { Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config";
import { runFullIngestion } from "./services/ingestion";
import { requireAdminKey } from "./services/adminAuth";
import { requireAdmin } from "./services/auth";

import stationsRouter from "./routes/stations";
import pricesRouter from "./routes/prices";
import authRouter from "./routes/auth";
import favouritesRouter from "./routes/favourites";
import discrepancyRouter from "./routes/discrepancy";
import complianceRouter from "./routes/compliance";
import adminRouter from "./routes/admin";

/**
 * Builds a fresh Express app with all middleware and routes wired up, but no
 * side effects (no DB connect, no cron, no listen) — callable repeatedly so
 * each test gets its own app instance with reset rate-limiter state.
 */
export function createApp(): Express {
  const app = express();

  // ── Middleware ────────────────────────────────────────

  app.use(helmet());

  // Browser-only mitigation: blocks cross-origin fetch/XHR from other sites.
  // Does not restrict curl/server-to-server access — that's covered by
  // rate limiting below and the admin key on internal endpoints.
  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  app.use(cors({ origin: allowedOrigins }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/", apiLimiter);

  const ingestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ── Routes ───────────────────────────────────────────

  app.use("/api/stations", stationsRouter);
  app.use("/api/prices", pricesRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/favourites", favouritesRouter);
  app.use("/api/discrepancy", discrepancyRouter);
  app.use("/api/admin/compliance", requireAdminKey, complianceRouter);

  app.get("/", (_req, res) => {
    res.json({ service: "UK Fuel Prices API", status: "ok" });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", poll_interval_minutes: env.POLL_INTERVAL_MINUTES });
  });

  /** Manual ingestion trigger (admin/testing) — shared-key gated for machine callers */
  app.post("/api/admin/ingest", ingestLimiter, requireAdminKey, async (_req, res) => {
    await runFullIngestion();
    res.json({ status: "ingestion_complete" });
  });

  // Admin/operations console API (JWT + role="admin"). Mounted after the
  // shared-key /api/admin/compliance and /api/admin/ingest routes above so it
  // doesn't shadow them; all other /api/admin/* paths fall through to here.
  app.use("/api/admin", requireAdmin, adminRouter);

  return app;
}
