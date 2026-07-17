import request from "supertest";

vi.mock("../db", () => ({
  prisma: {
    apiCallLog: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    discrepancyReport: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    station: {
      findUnique: vi.fn(),
    },
  },
  isPostgres: () => false,
}));

vi.mock("../services/ingestion", () => ({
  runFullIngestion: vi.fn().mockResolvedValue(undefined),
}));

import { createApp } from "../app";
import { prisma } from "../db";
import { runFullIngestion } from "../services/ingestion";
import { env } from "../config";

describe("admin-key-gated routes", () => {
  const app = createApp();
  const validKey = env.ADMIN_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/admin/ingest", () => {
    it("401s with no admin key", async () => {
      const res = await request(app).post("/api/admin/ingest");
      expect(res.status).toBe(401);
      expect(runFullIngestion).not.toHaveBeenCalled();
    });

    it("401s with the wrong admin key", async () => {
      const res = await request(app).post("/api/admin/ingest").set("X-Admin-Key", "totally-wrong");
      expect(res.status).toBe(401);
      expect(runFullIngestion).not.toHaveBeenCalled();
    });

    it("runs ingestion when the correct admin key is supplied", async () => {
      const res = await request(app).post("/api/admin/ingest").set("X-Admin-Key", validKey);
      expect(res.status).toBe(200);
      expect(runFullIngestion).toHaveBeenCalledOnce();
    });
  });

  describe("GET /api/admin/compliance/stats", () => {
    it("401s with no admin key", async () => {
      const res = await request(app).get("/api/admin/compliance/stats");
      expect(res.status).toBe(401);
      expect(prisma.apiCallLog.count).not.toHaveBeenCalled();
    });

    it("401s with the wrong admin key", async () => {
      const res = await request(app).get("/api/admin/compliance/stats").set("X-Admin-Key", "nope");
      expect(res.status).toBe(401);
    });

    it("200s with the correct admin key", async () => {
      vi.mocked(prisma.apiCallLog.count).mockResolvedValue(10);
      const res = await request(app).get("/api/admin/compliance/stats").set("X-Admin-Key", validKey);
      expect(res.status).toBe(200);
      expect(res.body.total_api_calls_today).toBe(10);
    });
  });

  describe("GET /api/admin/compliance/call-log", () => {
    it("401s with no admin key", async () => {
      const res = await request(app).get("/api/admin/compliance/call-log");
      expect(res.status).toBe(401);
      expect(prisma.apiCallLog.findMany).not.toHaveBeenCalled();
    });

    it("200s with the correct admin key", async () => {
      vi.mocked(prisma.apiCallLog.findMany).mockResolvedValue([]);
      const res = await request(app).get("/api/admin/compliance/call-log").set("X-Admin-Key", validKey);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /api/discrepancy/ (admin report list)", () => {
    it("401s with no admin key", async () => {
      const res = await request(app).get("/api/discrepancy/");
      expect(res.status).toBe(401);
      expect(prisma.discrepancyReport.findMany).not.toHaveBeenCalled();
    });

    it("200s with the correct admin key", async () => {
      vi.mocked(prisma.discrepancyReport.findMany).mockResolvedValue([]);
      const res = await request(app).get("/api/discrepancy/").set("X-Admin-Key", validKey);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("POST /api/discrepancy/ (public submission — not admin-gated)", () => {
    it("accepts a submission with no admin key", async () => {
      vi.mocked(prisma.discrepancyReport.create).mockResolvedValue({
        id: 1,
        stationId: null,
        description: "wrong price",
        forwardedToAggregator: false,
        createdAt: new Date(),
      } as any);

      const res = await request(app).post("/api/discrepancy/").send({ description: "wrong price" });
      expect(res.status).toBe(201);
    });
  });
});
