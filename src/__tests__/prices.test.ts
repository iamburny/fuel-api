import request from "supertest";

vi.mock("../db", () => ({
  prisma: {
    station: {
      findUnique: vi.fn(),
    },
    priceHistory: {
      findMany: vi.fn(),
    },
  },
  isPostgres: () => false,
}));

import { createApp } from "../app";
import { prisma } from "../db";

const mockedPrisma = prisma as unknown as {
  station: { findUnique: ReturnType<typeof vi.fn> };
  priceHistory: { findMany: ReturnType<typeof vi.fn> };
};

describe("GET /api/prices/history/:stationId", () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.station.findUnique.mockResolvedValue({ id: 4887, name: "TGC - DIDCOT" });
    mockedPrisma.priceHistory.findMany.mockResolvedValue([]);
  });

  it("404s for a station that doesn't exist", async () => {
    mockedPrisma.station.findUnique.mockResolvedValue(null);
    const res = await request(app).get("/api/prices/history/999999");
    expect(res.status).toBe(404);
  });

  it("filters by a bounded reportedAt range for a normal days value", async () => {
    await request(app).get("/api/prices/history/4887?fuel_type=E10&days=30");

    const call = mockedPrisma.priceHistory.findMany.mock.calls[0][0];
    expect(call.where.stationId).toBe(4887);
    expect(call.where.fuelType).toBe("E10");
    expect(call.where.reportedAt.gte).toBeInstanceOf(Date);
  });

  it("caps an oversized days value at 365", async () => {
    await request(app).get("/api/prices/history/4887?fuel_type=E10&days=100000");

    const call = mockedPrisma.priceHistory.findMany.mock.calls[0][0];
    const since = call.where.reportedAt.gte as Date;
    const daysAgo = (Date.now() - since.getTime()) / 86_400_000;
    expect(daysAgo).toBeCloseTo(365, 0);
  });

  it("days=all omits the reportedAt filter entirely, returning full history", async () => {
    await request(app).get("/api/prices/history/4887?fuel_type=E10&days=all");

    const call = mockedPrisma.priceHistory.findMany.mock.calls[0][0];
    expect(call.where.reportedAt).toBeUndefined();
    expect(call.where).toEqual({ stationId: 4887, fuelType: "E10" });
  });

  it("returns history points found by the query", async () => {
    mockedPrisma.priceHistory.findMany.mockResolvedValue([
      { pricePence: 155.9, reportedAt: new Date("2026-04-07T10:01:07.581Z") },
      { pricePence: 148.9, reportedAt: new Date("2026-07-13T09:45:20.472Z") },
    ]);

    const res = await request(app).get("/api/prices/history/4887?fuel_type=E10&days=all");

    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([
      { price_pence: 155.9, reported_at: "2026-04-07T10:01:07.581Z" },
      { price_pence: 148.9, reported_at: "2026-07-13T09:45:20.472Z" },
    ]);
  });
});
