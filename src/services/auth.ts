import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";
import { env } from "../config";
import { prisma } from "../db";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plain, hashed);
}

export function createToken(userId: number): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET as jwt.Secret, {
    expiresIn: env.JWT_EXPIRES_IN,
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
