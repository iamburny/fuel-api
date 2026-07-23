import { Router, Request, Response } from "express";
import { prisma } from "../db";
import {
  hashPassword,
  verifyPassword,
  createToken,
  requireAuth,
  verifyGoogleIdToken,
} from "../services/auth";
import { env } from "../config";

const router = Router();

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

  // Find or create/link, in priority order: existing Google link → existing email (link it) → new.
  let user = await prisma.user.findUnique({ where: { googleSub: identity.sub } });
  if (!user) {
    const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
    user = byEmail
      ? await prisma.user.update({
          where: { id: byEmail.id },
          data: { googleSub: identity.sub, lastLoginAt: new Date() },
        })
      : await prisma.user.create({
          data: {
            email: identity.email,
            googleSub: identity.sub,
            authProvider: "google",
            lastLoginAt: new Date(),
          },
        });
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  }

  res.json({ access_token: createToken(user.id), token_type: "bearer", role: user.role });
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
