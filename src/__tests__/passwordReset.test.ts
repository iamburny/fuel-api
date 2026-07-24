import request from "supertest";

// Mock the email sender so no real Resend call happens; assert it's invoked (or not) per case.
const { sendPasswordResetEmail } = vi.hoisted(() => ({ sendPasswordResetEmail: vi.fn() }));

vi.mock("../db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    passwordResetToken: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  },
  isPostgres: () => false,
}));

vi.mock("../services/email", () => ({ sendPasswordResetEmail }));

import { createApp } from "../app";
import { prisma } from "../db";

const mockedPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  passwordResetToken: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

describe("POST /api/auth/forgot-password", () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.passwordResetToken.create.mockResolvedValue({ id: 1 });
    sendPasswordResetEmail.mockResolvedValue({ sent: true });
  });

  it("creates a token and emails a link for a known password account", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ id: 5, email: "a@b.com", hashedPassword: "x" });

    const res = await request(app).post("/api/auth/forgot-password").send({ email: "a@b.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedPrisma.passwordResetToken.create).toHaveBeenCalledOnce();
    const emailArgs = sendPasswordResetEmail.mock.calls[0];
    expect(emailArgs[0]).toBe("a@b.com");
    expect(emailArgs[1]).toMatch(/\/reset-password\?token=[0-9a-f]{64}$/);
  });

  it("returns 200 but sends nothing for an unknown email (no enumeration)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/api/auth/forgot-password").send({ email: "nobody@b.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockedPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("sends nothing for a Google-only account (no password to reset)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ id: 6, email: "g@b.com", hashedPassword: null });

    const res = await request(app).post("/api/auth/forgot-password").send({ email: "g@b.com" });

    expect(res.status).toBe(200);
    expect(mockedPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("400s when email is missing", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/reset-password", () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.update.mockResolvedValue({ id: 5 });
    mockedPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
  });

  it("sets the new password and invalidates outstanding tokens for a valid token", async () => {
    mockedPrisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 1,
      userId: 5,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "raw-token", password: "brand-new-pass" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const updateArgs = mockedPrisma.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 5 });
    expect(updateArgs.data.hashedPassword).toBeTruthy();
    expect(mockedPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 5, usedAt: null } })
    );
  });

  it("400s for an expired token", async () => {
    mockedPrisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 1,
      userId: 5,
      usedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "raw-token", password: "brand-new-pass" });

    expect(res.status).toBe(400);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it("400s for an already-used token", async () => {
    mockedPrisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 1,
      userId: 5,
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "raw-token", password: "brand-new-pass" });

    expect(res.status).toBe(400);
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it("400s for an unknown token", async () => {
    mockedPrisma.passwordResetToken.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "nope", password: "brand-new-pass" });

    expect(res.status).toBe(400);
  });

  it("400s when the new password is too short", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "raw-token", password: "short" });

    expect(res.status).toBe(400);
    expect(mockedPrisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
  });

  it("400s when token or password is missing", async () => {
    const res = await request(app).post("/api/auth/reset-password").send({ token: "x" });
    expect(res.status).toBe(400);
  });
});
