import request from "supertest";

vi.mock("../db", () => ({
  prisma: {},
  isPostgres: () => false,
}));

import { createApp } from "../app";

describe("CORS allowlist", () => {
  const app = createApp();

  it("includes Access-Control-Allow-Origin for an allowed origin", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://fueltracker.uk");
    expect(res.headers["access-control-allow-origin"]).toBe("https://fueltracker.uk");
  });

  it("omits Access-Control-Allow-Origin for a disallowed origin", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still responds normally with no Origin header at all (e.g. curl, native apps)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("rate limiting", () => {
  const app = createApp();

  it("advertises the configured request budget via RateLimit headers", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["ratelimit-limit"]).toBe("300");
  });
});
