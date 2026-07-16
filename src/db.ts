import { PrismaClient } from "@prisma/client";
import { env } from "./config";

export const prisma = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/** True when running against the production Postgres datasource rather than dev SQLite. */
export const isPostgres = () => (env.DATABASE_URL ?? "").startsWith("postgres");
