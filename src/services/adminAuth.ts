import { timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { env } from "../config";

/**
 * Express middleware guarding admin-only endpoints (ingest trigger,
 * compliance stats/log, discrepancy list) behind a shared secret sent
 * as `X-Admin-Key`. Uses a constant-time comparison to avoid leaking
 * the key length/content via response-time side channels.
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers["x-admin-key"];

  if (typeof provided !== "string" || !safeEquals(provided, env.ADMIN_API_KEY)) {
    res.status(401).json({ detail: "Missing or invalid admin key" });
    return;
  }

  next();
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
