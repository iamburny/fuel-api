import { z } from "zod";

const envSchema = z.object({
  // App
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Database (Prisma reads DATABASE_URL directly)
  DATABASE_URL: z.string().default("file:./fuel.db"),

  // Gov Fuel Finder API
  FUEL_FINDER_BASE_URL: z.string().default("https://www.fuel-finder.service.gov.uk"),
  FUEL_FINDER_CLIENT_ID: z.string().default(""),
  FUEL_FINDER_CLIENT_SECRET: z.string().default(""),

  // Polling — Fair Use Policy: must not poll more often than every 5 min
  POLL_INTERVAL_MINUTES: z.coerce.number().default(30),

  // JWT auth for app users
  JWT_SECRET: z.string().default("CHANGE-ME-in-production"),
  JWT_EXPIRES_IN: z.string().default("24h"),

  // Compliance
  DISCREPANCY_REPORT_URL: z
    .string()
    .default("https://www.fuel-finder.service.gov.uk/report-discrepancy"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const env = parsed.data;

  // Compliance: Fair Use Policy forbids polling more often than every 5 min
  if (env.POLL_INTERVAL_MINUTES < 5) {
    console.warn(
      `⚠ COMPLIANCE WARNING: POLL_INTERVAL_MINUTES=${env.POLL_INTERVAL_MINUTES} ` +
        `is below the Fair Use Policy minimum of 5 minutes. Clamping to 5.`
    );
    env.POLL_INTERVAL_MINUTES = 5;
  }

  return env;
}

export const env = loadEnv();
