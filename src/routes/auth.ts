import { Router, Request, Response } from "express";
import crypto from "crypto";
import { prisma } from "../db";
import {
  hashPassword,
  verifyPassword,
  createToken,
  requireAuth,
  verifyGoogleIdToken,
} from "../services/auth";
import { sendPasswordResetEmail } from "../services/email";
import { env } from "../config";

const router = Router();

/** sha256 hex of a value — reset tokens are stored hashed, never in the clear. */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** POST /api/auth/register */
router.post("/register", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ detail: "email and password are required" });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ detail: "Email already registered" });
    return;
  }

  const user = await prisma.user.create({
    data: { email, hashedPassword: await hashPassword(password) },
  });

  res.status(201).json({ id: user.id, email: user.email });
});

/** POST /api/auth/login (form-encoded: username + password) */
router.post("/login", async (req: Request, res: Response) => {
  // Accept both JSON body and form-encoded (for OAuth2PasswordRequestForm compat)
  const email = req.body.username ?? req.body.email;
  const password = req.body.password;

  if (!email || !password) {
    res.status(400).json({ detail: "username/email and password are required" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // `hashedPassword` is null for Google-only accounts — they must use Google sign-in, not password.
  if (!user || !user.hashedPassword || !(await verifyPassword(password, user.hashedPassword))) {
    res.status(401).json({ detail: "Invalid credentials" });
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  res.json({ access_token: createToken(user.id), token_type: "bearer", role: user.role });
});

/**
 * POST /api/auth/google — Google Sign-In. Verifies the client's Google ID token, then finds or
 * creates the matching user and issues the same JWT as /login, so all requireAuth routes (incl.
 * favourites) work unchanged. Body: { id_token }.
 */
router.post("/google", async (req: Request, res: Response) => {
  if (!env.GOOGLE_CLIENT_ID) {
    res.status(503).json({ detail: "Google sign-in is not configured" });
    return;
  }

  const idToken = req.body.id_token ?? req.body.credential;
  if (!idToken) {
    res.status(400).json({ detail: "id_token is required" });
    return;
  }

  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch {
    res.status(401).json({ detail: "Invalid Google token" });
    return;
  }
  if (!identity.emailVerified) {
    res.status(401).json({ detail: "Google email not verified" });
    return;
  }

  // Google display name / avatar, refreshed on every sign-in. `undefined` (Prisma no-op) when the
  // token omits a claim, so we never wipe an existing value with null.
  const profile = {
    displayName: identity.name ?? undefined,
    avatarUrl: identity.picture ?? undefined,
  };

  // Find or create/link, in priority order: existing Google link → existing email (link it) → new.
  let user = await prisma.user.findUnique({ where: { googleSub: identity.sub } });
  if (!user) {
    const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
    user = byEmail
      ? await prisma.user.update({
          where: { id: byEmail.id },
          data: { googleSub: identity.sub, lastLoginAt: new Date(), ...profile },
        })
      : await prisma.user.create({
          data: {
            email: identity.email,
            googleSub: identity.sub,
            authProvider: "google",
            lastLoginAt: new Date(),
            ...profile,
          },
        });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), ...profile },
    });
  }

  res.json({ access_token: createToken(user.id), token_type: "bearer", role: user.role });
});

/**
 * POST /api/auth/forgot-password — start a password reset. Body: { email }.
 * Always returns 200 { ok: true } regardless of whether the address is registered, so the endpoint
 * can't be used to enumerate accounts. Only actually emails a link when the account exists and has a
 * password identity (Google-only accounts have no password to reset).
 */
router.post("/forgot-password", async (req: Request, res: Response) => {
  const email = req.body.email;
  if (!email) {
    res.status(400).json({ detail: "email is required" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.hashedPassword) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });
    const base = env.WEB_BASE_URL.replace(/\/$/, "");
    await sendPasswordResetEmail(user.email, `${base}/reset-password?token=${rawToken}`);
  }

  res.json({ ok: true });
});

/**
 * POST /api/auth/reset-password — complete a password reset. Body: { token, password }.
 * Validates the (hashed) token, sets the new password, and invalidates all of the user's
 * outstanding reset tokens so the link is strictly single-use.
 */
router.post("/reset-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token || !password) {
    res.status(400).json({ detail: "token and password are required" });
    return;
  }
  if (String(password).length < 8) {
    res.status(400).json({ detail: "Password must be at least 8 characters" });
    return;
  }

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(String(token)) },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    res.status(400).json({ detail: "This reset link is invalid or has expired." });
    return;
  }

  await prisma.user.update({
    where: { id: record.userId },
    data: { hashedPassword: await hashPassword(password) },
  });
  // Mark this token (and any other outstanding ones for the user) used in one go.
  await prisma.passwordResetToken.updateMany({
    where: { userId: record.userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  res.json({ ok: true });
});

/** POST /api/auth/fcm-token — store Firebase Cloud Messaging token */
router.post("/fcm-token", requireAuth, async (req: Request, res: Response) => {
  const fcmToken = req.query.fcm_token as string ?? req.body.fcm_token;
  if (!fcmToken) {
    res.status(400).json({ detail: "fcm_token is required" });
    return;
  }

  await prisma.user.update({
    where: { id: (req as any).userId },
    data: { fcmToken },
  });

  res.json({ status: "ok" });
});

export default router;
