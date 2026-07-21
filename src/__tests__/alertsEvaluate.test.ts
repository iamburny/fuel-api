// Unit tests for the area/favourite alert fan-out. Prisma and the FCM sender are mocked; the real
// haversine from services/geo is used so the distance filter is genuinely exercised.

const sendMock = vi.fn();

vi.mock("../db", () => ({
  prisma: {
    station: { findMany: vi.fn() },
    alertSubscription: { findMany: vi.fn(), update: vi.fn() },
    favourite: { findMany: vi.fn() },
  },
  isPostgres: () => false,
}));

vi.mock("../services/fcm", () => ({
  sendPriceDropNotification: (...args: any[]) => sendMock(...args),
}));

import { evaluateAlerts } from "../services/alerts";
import { prisma } from "../db";

// A dropped E10 price at a London station.
const LONDON = { id: 1, name: "Test Garage", latitude: 51.5074, longitude: -0.1278 };
const drop = { stationId: 1, fuelType: "E10", newPence: 129.9 };

function subscription(overrides: Record<string, any> = {}) {
  return {
    id: 10,
    latitude: 51.5074,
    longitude: -0.1278,
    radiusMiles: 10,
    fuelType: "E10",
    notify: true,
    lastNotifiedPence: null,
    user: { fcmToken: "token-abc" },
    ...overrides,
  };
}

describe("evaluateAlerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMock.mockResolvedValue({ sent: true });
    (prisma.station.findMany as any).mockResolvedValue([LONDON]);
    (prisma.favourite.findMany as any).mockResolvedValue([]);
    (prisma.alertSubscription.update as any).mockResolvedValue({});
  });

  it("notifies a subscription whose point is within radius and updates lastNotifiedPence", async () => {
    (prisma.alertSubscription.findMany as any).mockResolvedValue([subscription()]);

    const res = await evaluateAlerts([drop]);

    expect(res.areaSent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("token-abc", expect.objectContaining({
      stationId: 1,
      fuelType: "E10",
      pricePence: 129.9,
    }));
    expect(prisma.alertSubscription.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { lastNotifiedPence: 129.9 },
    });
  });

  it("does not notify a subscription outside its radius", async () => {
    // ~150 miles north; radius 10 → excluded by the haversine filter.
    (prisma.alertSubscription.findMany as any).mockResolvedValue([
      subscription({ latitude: 53.8, longitude: -1.5, radiusMiles: 10 }),
    ]);

    const res = await evaluateAlerts([drop]);

    expect(res.areaSent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("throttles when the new price is not below lastNotifiedPence", async () => {
    (prisma.alertSubscription.findMany as any).mockResolvedValue([
      subscription({ lastNotifiedPence: 129.9 }), // same as the drop → not a new low
    ]);

    const res = await evaluateAlerts([drop]);

    expect(res.areaSent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns zero and skips DB work for an empty drop list", async () => {
    const res = await evaluateAlerts([]);
    expect(res).toEqual({ areaSent: 0, favouriteSent: 0 });
    expect(prisma.station.findMany).not.toHaveBeenCalled();
  });
});
