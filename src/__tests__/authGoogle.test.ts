import request from "supertest";

// Set GOOGLE_CLIENT_ID before config loads (else the /google route short-circuits to 503), and
// create the verify mock — both in a hoisted block so they run before the module graph imports.
const { verifyGoogleIdToken } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  return { verifyGoogleIdToken: vi.fn() };
});

vi.mock("../db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
  isPostgres: () => false,
}));

// Keep the real createToken/requireAuth; only stub the Google token verification.
vi.mock("../services/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/auth")>();
  return { ...actual, verifyGoogleIdToken };
});

import { createApp } from "../app";
import { prisma } from "../db";

describe("POST /api/auth/google", () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new user when the Google account is unknown", async () => {
    verifyGoogleIdToken.mockResolvedValue({
      sub: "g-123",
      email: "new@example.com",
      emailVerified: true,
      name: "New User",
    });
    (prisma.user.findUnique as any).mockResolvedValue(null); // no googleSub match, no email match
    (prisma.user.create as any).mockResolvedValue({ id: 7, email: "new@example.com", role: "user" });

    const res = await request(app).post("/api/auth/google").send({ id_token: "tok" });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.token_type).toBe("bearer");
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "new@example.com", googleSub: "g-123", authProvider: "google" }),
      })
    );
  });

  it("links an existing email account on first Google login", async () => {
    verifyGoogleIdToken.mockResolvedValue({ sub: "g-1", email: "e@x.com", emailVerified: true });
    (prisma.user.findUnique as any)
      .mockResolvedValueOnce(null) // by googleSub → none
      .mockResolvedValueOnce({ id: 3, email: "e@x.com", role: "user" }); // by email → existing
    (prisma.user.update as any).mockResolvedValue({ id: 3, email: "e@x.com", role: "user" });

    const res = await request(app).post("/api/auth/google").send({ id_token: "tok" });

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3 }, data: expect.objectContaining({ googleSub: "g-1" }) })
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("401s when the Google email is unverified", async () => {
    verifyGoogleIdToken.mockResolvedValue({ sub: "g", email: "e@x.com", emailVerified: false });

    const res = await request(app).post("/api/auth/google").send({ id_token: "tok" });

    expect(res.status).toBe(401);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("401s when token verification fails", async () => {
    verifyGoogleIdToken.mockRejectedValue(new Error("bad token"));

    const res = await request(app).post("/api/auth/google").send({ id_token: "tok" });

    expect(res.status).toBe(401);
  });

  it("400s when id_token is missing", async () => {
    const res = await request(app).post("/api/auth/google").send({});
    expect(res.status).toBe(400);
    expect(verifyGoogleIdToken).not.toHaveBeenCalled();
  });
});
