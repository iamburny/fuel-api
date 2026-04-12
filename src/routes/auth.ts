import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { hashPassword, verifyPassword, createToken, requireAuth } from "../services/auth";

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
  if (!user || !(await verifyPassword(password, user.hashedPassword))) {
    res.status(401).json({ detail: "Invalid credentials" });
    return;
  }

  res.json({ access_token: createToken(user.id), token_type: "bearer" });
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
