import cron from "node-cron";
import { env } from "./config";
import { prisma } from "./db";
import { runFullIngestion } from "./services/ingestion";
import { createApp } from "./app";

const app = createApp();

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
