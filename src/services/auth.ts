import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config";
import { prisma } from "../db";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/** The verified claims we care about from a Google ID token. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

// Reused across requests; the audience check pins tokens to our own OAuth client.
const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/**
 * Verifies a Google ID token against our Web OAuth client id (the audience) and returns the
 * claims. Throws if the token is invalid/for another audience. Kept here (not inline in the route)
 * so it can be mocked in tests.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google token missing required claims");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
  };
}

export function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plain, hashed);
}

export function createToken(userId: number, expiresIn: string = env.JWT_EXPIRES_IN): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET as jwt.Secret, {
    expiresIn,
  } as jwt.SignOptions);
}

/**
 * Express middleware: extracts JWT, attaches `req.userId`.
 * Returns 401 if token is missing/invalid.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing token" });
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as unknown as { sub: number };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      res.status(401).json({ detail: "User not found" });
      return;
    }
    (req as any).userId = user.id;
    (req as any).user = user;
    next();
  } catch {
    res.status(401).json({ detail: "Invalid token" });
  }
}

/**
 * Express middleware: like {@link requireAuth}, but additionally requires the
 * authenticated user to have the "admin" role. Returns 401 if the token is
 * missing/invalid, 403 if the user is authenticated but not an admin.
 *
 * This is the JWT/account-based gate for the fuel-admin console. The older
 * shared-secret `requireAdminKey` (services/adminAuth.ts) remains for machine
 * callers (cron, scripts) that don't have an admin account.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  await requireAuth(req, res, () => {
    const user = (req as any).user;
    if (user?.role !== "admin") {
      res.status(403).json({ detail: "Admin access required" });
      return;
    }
    next();
  });
}
