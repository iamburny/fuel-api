import request from "supertest";

vi.mock("../db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    station: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    fuelPrice: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), aggregate: vi.fn() },
    priceHistory: { findMany: vi.fn() },
    favourite: { count: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    discrepancyReport: { count: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    apiCallLog: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
  isPostgres: () => false,
}));

vi.mock("../services/ingestion", () => ({
  runFullIngestion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/fcm", () => ({
  sendPriceDropNotification: vi.fn().mockResolvedValue({ sent: true, messageId: "msg-1" }),
  isFcmEnabled: () => true,
}));

import { createApp } from "../app";
import { prisma } from "../db";
import { createToken } from "../services/auth";
import { sendPriceDropNotification } from "../services/fcm";

const ADMIN = { id: 1, email: "admin@example.com", role: "admin", fcmToken: null };
const NON_ADMIN = { id: 2, email: "user@example.com", role: "user", fcmToken: null };

const adminToken = createToken(ADMIN.id);
const userToken = createToken(NON_ADMIN.id);

/** Queues the auth-loading findUnique (called by requireAuth) to return the admin. */
function authAsAdmin() {
  vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(ADMIN as any);
}

describe("requireAdmin gating on /api/admin/*", () => {
  const app = createApp();

  beforeEach(() => vi.clearAllMocks());

  it("401s with no token", async () => {
    const res = await request(app).get("/api/admin/overview");
    expect(res.status).toBe(401);
  });

  it("403s for a valid non-admin token", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(NON_ADMIN as any);
    const res = await request(app).get("/api/admin/overview").set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  it("allows a valid admin token", async () => {
    authAsAdmin();
    vi.mocked(prisma.station.count).mockResolvedValue(10);
    vi.mocked(prisma.fuelPrice.count).mockResolvedValue(50);
    vi.mocked(prisma.user.count).mockResolvedValue(3);
    vi.mocked(prisma.favourite.count).mockResolvedValue(5);
    vi.mocked(prisma.discrepancyReport.count).mockResolvedValue(2);
    vi.mocked(prisma.apiCallLog.findFirst).mockResolvedValue({
      calledAt: new Date(),
      endpoint: "/api/v1/pfs",
      success: true,
      errorMessage: null,
    } as any);
    vi.mocked(prisma.apiCallLog.count).mockResolvedValue(20);
    vi.mocked(prisma.fuelPrice.aggregate).mockResolvedValue({ _max: { fetchedAt: new Date() } } as any);

    const res = await request(app).get("/api/admin/overview").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.counts.stations).toBe(10);
    expect(res.body.counts.open_discrepancies).toBe(2);
  });
});

describe("admin console endpoints", () => {
  const app = createApp();

  beforeEach(() => vi.clearAllMocks());

  it("GET /api/admin/users returns a paginated list", async () => {
    authAsAdmin();
    vi.mocked(prisma.user.count).mockResolvedValue(1);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { ...NON_ADMIN, createdAt: new Date(), lastLoginAt: null, _count: { favourites: 2 } },
    ] as any);

    const res = await request(app).get("/api/admin/users").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].email).toBe(NON_ADMIN.email);
    expect(res.body.items[0].favourites_count).toBe(2);
  });

  it("GET /api/admin/users/:id returns profile, favourites (with price) and alerts", async () => {
    authAsAdmin();
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      ...NON_ADMIN,
      authProvider: "google",
      googleSub: "g-9",
      displayName: "Jane Doe",
      avatarUrl: "https://lh3.googleusercontent.com/a/jane",
      createdAt: new Date(),
      lastLoginAt: new Date(),
      favourites: [
        {
          id: 11,
          stationId: 22,
          fuelType: "E10",
          notifyOnDrop: true,
          priceThresholdPence: 140,
          createdAt: new Date(),
          station: {
            id: 22,
            name: "Didcot Superstore",
            postcode: "OX11",
            prices: [{ fuelType: "E10", pricePence: 138.9 }],
          },
        },
      ],
      alertSubscriptions: [
        {
          id: 5,
          label: "Home",
          fuelType: "E10",
          radiusMiles: 10,
          latitude: 51.6,
          longitude: -1.2,
          notify: true,
          createdAt: new Date(),
        },
      ],
    } as any);

    const res = await request(app)
      .get("/api/admin/users/2")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.auth_provider).toBe("google");
    expect(res.body.google_linked).toBe(true);
    expect(res.body.display_name).toBe("Jane Doe");
    expect(res.body.avatar_url).toContain("googleusercontent.com");
    expect(res.body.favourites[0].current_price_pence).toBe(138.9);
    expect(res.body.alert_subscriptions[0].label).toBe("Home");
  });

  it("PATCH /api/admin/discrepancies/:id resolves a report", async () => {
    authAsAdmin();
    vi.mocked(prisma.discrepancyReport.update).mockResolvedValue({
      id: 7,
      forwardedToAggregator: false,
      resolvedAt: new Date(),
    } as any);

    const res = await request(app)
      .patch("/api/admin/discrepancies/7")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ resolved: true });

    expect(res.status).toBe(200);
    expect(res.body.resolved_at).toBeTruthy();
    expect(vi.mocked(prisma.discrepancyReport.update)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    );
  });

  it("POST /api/admin/notifications/test sends via FCM", async () => {
    // 1st findUnique = auth (admin), 2nd = target user
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(ADMIN as any)
      .mockResolvedValueOnce({ ...NON_ADMIN, fcmToken: "device-token" } as any);

    const res = await request(app)
      .post("/api/admin/notifications/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ user_id: NON_ADMIN.id });

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(vi.mocked(sendPriceDropNotification)).toHaveBeenCalledWith(
      "device-token",
      expect.objectContaining({ fuelType: "E10" })
    );
  });

  it("POST /api/admin/impersonate/:userId mints a short-lived token", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(ADMIN as any)
      .mockResolvedValueOnce(NON_ADMIN as any);

    const res = await request(app)
      .post(`/api/admin/impersonate/${NON_ADMIN.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe("string");
    expect(res.body.user.id).toBe(NON_ADMIN.id);
  });

  it("GET /api/admin/endpoints returns the catalog", async () => {
    authAsAdmin();
    const res = await request(app).get("/api/admin/endpoints").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((e: any) => e.path === "/api/prices/averages")).toBe(true);
  });

  it("DELETE /api/admin/users/:id refuses self-deletion", async () => {
    authAsAdmin();
    const res = await request(app)
      .delete(`/api/admin/users/${ADMIN.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(vi.mocked(prisma.user.delete)).not.toHaveBeenCalled();
  });
});
