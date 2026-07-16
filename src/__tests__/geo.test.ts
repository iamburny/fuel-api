import { haversine, boundingBox, findNearbyStations, findCheapest, findStationsInBounds } from "../services/geo";

vi.mock("../db", () => ({
  prisma: {
    station: {
      findMany: vi.fn(),
    },
    fuelPrice: {
      findMany: vi.fn(),
    },
  },
  // These tests mock the SQLite/dev query path (the one Prisma's mocked findMany calls
  // represent) — isPostgres() must return false so findNearbyStations/findCheapest take that
  // branch instead of attempting a $queryRaw call the mock doesn't provide.
  isPostgres: () => false,
}));

import { prisma } from "../db";

describe("haversine", () => {
  it("returns 0 for same point", () => {
    expect(haversine(51.5, -0.1, 51.5, -0.1)).toBe(0);
  });

  it("calculates London to Manchester as ~163 miles", () => {
    const distance = haversine(51.5074, -0.1278, 53.4808, -2.2426);
    expect(distance).toBeGreaterThan(161);
    expect(distance).toBeLessThan(165);
  });

  it("is symmetric (a to b equals b to a)", () => {
    const ab = haversine(51.5074, -0.1278, 53.4808, -2.2426);
    const ba = haversine(53.4808, -2.2426, 51.5074, -0.1278);
    expect(ab).toBeCloseTo(ba, 10);
  });
});

describe("boundingBox", () => {
  it("returns sensible min/max lat/lng for 10-mile radius at London", () => {
    const box = boundingBox(51.5074, -0.1278, 10);

    // 10 miles ~ 0.145 degrees latitude
    expect(box.minLat).toBeLessThan(51.5074);
    expect(box.maxLat).toBeGreaterThan(51.5074);
    expect(box.minLng).toBeLessThan(-0.1278);
    expect(box.maxLng).toBeGreaterThan(-0.1278);

    // Rough check: delta lat should be ~0.145 each way
    const dLat = box.maxLat - 51.5074;
    expect(dLat).toBeGreaterThan(0.1);
    expect(dLat).toBeLessThan(0.2);

    // delta lng is wider at this latitude due to cos factor
    const dLng = box.maxLng - (-0.1278);
    expect(dLng).toBeGreaterThan(0.1);
    expect(dLng).toBeLessThan(0.3);
  });
});

describe("findNearbyStations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters by radius, sorts by distance, and respects limit", async () => {
    const mockStations = [
      { id: 1, latitude: 51.51, longitude: -0.13, prices: [] },   // very close
      { id: 2, latitude: 51.6, longitude: -0.1, prices: [] },     // ~6.5 miles
      { id: 3, latitude: 52.5, longitude: -0.1, prices: [] },     // ~69 miles — outside radius
    ];

    vi.mocked(prisma.station.findMany).mockResolvedValue(mockStations as any);

    const results = await findNearbyStations(51.5074, -0.1278, 10, undefined, 20);

    expect(prisma.station.findMany).toHaveBeenCalledOnce();

    // Station 3 should be filtered out (too far)
    expect(results.length).toBe(2);

    // Should be sorted by distance ascending
    expect(results[0].station.id).toBe(1);
    expect(results[1].station.id).toBe(2);

    // Distance should be a number
    expect(typeof results[0].distanceMiles).toBe("number");
    expect(results[0].distanceMiles).toBeLessThan(results[1].distanceMiles);
  });

  it("respects the limit parameter", async () => {
    const mockStations = [
      { id: 1, latitude: 51.508, longitude: -0.128, prices: [] },
      { id: 2, latitude: 51.509, longitude: -0.129, prices: [] },
      { id: 3, latitude: 51.510, longitude: -0.130, prices: [] },
    ];

    vi.mocked(prisma.station.findMany).mockResolvedValue(mockStations as any);

    const results = await findNearbyStations(51.5074, -0.1278, 10, undefined, 2);
    expect(results.length).toBe(2);
  });
});

describe("findCheapest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns prices sorted by pricePence and filters by radius", async () => {
    const mockPrices = [
      {
        id: 1,
        fuelType: "E10",
        pricePence: 140,
        station: { id: 1, latitude: 51.51, longitude: -0.13 },
      },
      {
        id: 2,
        fuelType: "E10",
        pricePence: 145,
        station: { id: 2, latitude: 51.6, longitude: -0.1 },
      },
      {
        id: 3,
        fuelType: "E10",
        pricePence: 150,
        station: { id: 3, latitude: 53.0, longitude: -2.0 },  // far away
      },
    ];

    vi.mocked(prisma.fuelPrice.findMany).mockResolvedValue(mockPrices as any);

    const results = await findCheapest("E10", 51.5074, -0.1278, 10, 10);

    expect(prisma.fuelPrice.findMany).toHaveBeenCalledOnce();

    // Station 3 is outside radius, should be filtered
    expect(results.length).toBe(2);
    expect(results[0].price.pricePence).toBe(140);
    expect(results[1].price.pricePence).toBe(145);
    expect(results[0].distanceMiles).not.toBeNull();
  });

  it("works without location (no radius filter)", async () => {
    const mockPrices = [
      {
        id: 1,
        fuelType: "E10",
        pricePence: 140,
        station: { id: 1, latitude: 51.51, longitude: -0.13 },
      },
    ];

    vi.mocked(prisma.fuelPrice.findMany).mockResolvedValue(mockPrices as any);

    const results = await findCheapest("E10");

    expect(results.length).toBe(1);
    expect(results[0].distanceMiles).toBeNull();
  });
});

describe("findStationsInBounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries by the exact box with a DB-side limit, no distance filtering", async () => {
    const mockStations = [
      { id: 1, latitude: 51.0, longitude: -0.1, prices: [] },
      { id: 2, latitude: 51.2, longitude: -0.2, prices: [] },
    ];

    vi.mocked(prisma.station.findMany).mockResolvedValue(mockStations as any);

    const results = await findStationsInBounds(50.5, 51.5, -0.5, 0.5, undefined, 50);

    expect(prisma.station.findMany).toHaveBeenCalledOnce();
    expect(prisma.station.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          latitude: { gte: 50.5, lte: 51.5 },
          longitude: { gte: -0.5, lte: 0.5 },
        },
        take: 50,
      })
    );
    expect(results).toEqual(mockStations);
  });
});
