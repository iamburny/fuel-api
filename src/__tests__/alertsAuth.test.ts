import request from "supertest";

vi.mock("../db", () => ({
  prisma: {
    alertSubscription: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
  isPostgres: () => false,
}));

import { createApp } from "../app";
import { prisma } from "../db";

describe("requireAuth on /api/alerts", () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s with no Authorization header", async () => {
    const res = await request(app).get("/api/alerts/");
    expect(res.status).toBe(401);
    expect(prisma.alertSubscription.findMany).not.toHaveBeenCalled();
  });

  it("401s with a malformed Authorization header", async () => {
    const res = await request(app).get("/api/alerts/").set("Authorization", "not-a-bearer-token");
    expect(res.status).toBe(401);
  });

  it("401s with a well-formed but invalid JWT", async () => {
    const res = await request(app).get("/api/alerts/").set("Authorization", "Bearer not.a.valid.jwt");
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("401s on POST with no Authorization header (create is gated too)", async () => {
    const res = await request(app)
      .post("/api/alerts/")
      .send({ latitude: 51.5, longitude: -0.1 });
    expect(res.status).toBe(401);
    expect(prisma.alertSubscription.create).not.toHaveBeenCalled();
  });
});
