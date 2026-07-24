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

  // Google Sign-In: the Web OAuth client ID. Used as the audience when verifying ID tokens from
  // the Android app and the web frontend. Empty = Google login disabled (endpoint returns 503).
  GOOGLE_CLIENT_ID: z.string().default(""),

  // Admin-only endpoints (ingest trigger, compliance stats/log, discrepancy list)
  ADMIN_API_KEY: z.string().default("dev-only-admin-key-CHANGE-ME"),

  // CORS: comma-separated list of allowed origins
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("https://fueltracker.uk,https://www.fueltracker.uk,http://localhost:3000"),

  // Compliance
  DISCREPANCY_REPORT_URL: z
    .string()
    .default("https://www.fuel-finder.service.gov.uk/report-discrepancy"),

  // Firebase Cloud Messaging (price-drop push notifications). Either an inline
  // service-account JSON string or a path to the JSON file. Empty = FCM disabled
  // (send calls become no-ops that report `skipped`), so dev/test needs no secret.
  FIREBASE_SERVICE_ACCOUNT: z.string().default(""),

  // Transactional email (password-reset links), sent via Resend. Empty = email disabled
  // (send calls become no-ops that report `skipped`), so dev/test needs no key.
  RESEND_API_KEY: z.string().default(""),
  // The From address for outgoing mail — must be on a domain verified in Resend.
  EMAIL_FROM: z.string().default("Fuel Tracker UK <no-reply@fueltracker.uk>"),
  // Base URL of the web frontend, used to build password-reset links in emails.
  WEB_BASE_URL: z.string().default("https://fueltracker.uk"),
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

  // Refuse to start in production with known-default secrets — these gate
  // the JWT auth and the admin-only endpoints, so a default here means
  // anyone can forge tokens or hit /api/admin/* unauthenticated.
  if (env.NODE_ENV === "production") {
    const weakSecrets: string[] = [];
    if (env.JWT_SECRET === "CHANGE-ME-in-production" || env.JWT_SECRET.length < 20) {
      weakSecrets.push("JWT_SECRET");
    }
    if (env.ADMIN_API_KEY === "dev-only-admin-key-CHANGE-ME" || env.ADMIN_API_KEY.length < 20) {
      weakSecrets.push("ADMIN_API_KEY");
    }
    if (weakSecrets.length > 0) {
      console.error(
        `❌ Refusing to start in production with default/weak secret(s): ${weakSecrets.join(", ")}. ` +
          `Set a long random value (e.g. \`openssl rand -hex 32\`) for each in your production env.`
      );
      process.exit(1);
    }
  }

  return env;
}

export const env = loadEnv();
