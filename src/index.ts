import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { env } from "./config";
import { prisma } from "./db";
import { runFullIngestion } from "./services/ingestion";
import { requireAdminKey } from "./services/adminAuth";

import stationsRouter from "./routes/stations";
import pricesRouter from "./routes/prices";
import authRouter from "./routes/auth";
import favouritesRouter from "./routes/favourites";
import discrepancyRouter from "./routes/discrepancy";
import complianceRouter from "./routes/compliance";

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

/** Manual ingestion trigger (admin/testing) */
app.post("/api/admin/ingest", ingestLimiter, requireAdminKey, async (_req, res) => {
  await runFullIngestion();
  res.json({ status: "ingestion_complete" });
});

// ── Startup ──────────────────────────────────────────

async function start() {
  // Ensure DB is ready (Prisma auto-creates for SQLite on first query)
  await prisma.$connect();
  console.log("✅ Database connected");

  // Schedule ingestion — Fair Use Policy: no more often than every 5 min
  const interval = Math.max(env.POLL_INTERVAL_MINUTES, 5);
  cron.schedule(`*/${interval} * * * *`, () => {
    console.log(`[Cron] Running scheduled ingestion (every ${interval} min)`);
    runFullIngestion();
  });
  console.log(`⏱ Scheduler started: polling every ${interval} minutes`);

  // Initial ingestion if credentials configured
  if (env.FUEL_FINDER_CLIENT_ID) {
    console.log("🔄 Running initial data ingestion...");
    runFullIngestion();
  } else {
    console.warn(
      "⚠ No Fuel Finder API credentials — skipping ingestion.\n" +
        "  Set FUEL_FINDER_CLIENT_ID and FUEL_FINDER_CLIENT_SECRET in .env"
    );
  }

  app.listen(env.PORT, () => {
    console.log(`🚀 Fuel Prices API running on http://localhost:${env.PORT}`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

export default app;
