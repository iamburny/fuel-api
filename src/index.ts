import express from "express";
import cors from "cors";
import cron from "node-cron";
import { env } from "./config";
import { prisma } from "./db";
import { runFullIngestion } from "./services/ingestion";

import stationsRouter from "./routes/stations";
import pricesRouter from "./routes/prices";
import authRouter from "./routes/auth";
import favouritesRouter from "./routes/favourites";
import discrepancyRouter from "./routes/discrepancy";
import complianceRouter from "./routes/compliance";

const app = express();

// ── Middleware ────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ───────────────────────────────────────────

app.use("/api/stations", stationsRouter);
app.use("/api/prices", pricesRouter);
app.use("/api/auth", authRouter);
app.use("/api/favourites", favouritesRouter);
app.use("/api/discrepancy", discrepancyRouter);
app.use("/api/admin/compliance", complianceRouter);

app.get("/", (_req, res) => {
  res.json({ service: "UK Fuel Prices API", status: "ok" });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", poll_interval_minutes: env.POLL_INTERVAL_MINUTES });
});

/** Manual ingestion trigger (admin/testing) */
app.post("/api/admin/ingest", async (_req, res) => {
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
