import request from "supertest";

vi.mock("../db", () => ({
  prisma: {
    favourite: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
  isPostgres: () => false,
}));

import { createApp } from "../app";
import { prisma } from "../db";

describe("requireAuth on /api/favourites", () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s with no Authorization header", async () => {
    const res = await request(app).get("/api/favourites/");
    expect(res.status).toBe(401);
    expect(prisma.favourite.findMany).not.toHaveBeenCalled();
  });

  it("401s with a malformed Authorization header", async () => {
    const res = await request(app).get("/api/favourites/").set("Authorization", "not-a-bearer-token");
    expect(res.status).toBe(401);
  });

  it("401s with a well-formed but invalid JWT", async () => {
    const res = await request(app).get("/api/favourites/").set("Authorization", "Bearer not.a.valid.jwt");
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
