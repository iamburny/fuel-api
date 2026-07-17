vi.mock("../db", () => ({
  prisma: {
    apiCallLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    station: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    fuelPrice: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    priceHistory: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("../services/fuelFinderClient", () => ({
  fuelFinderClient: {
    fetchStations: vi.fn().mockResolvedValue([]),
    fetchFuelPrices: vi.fn().mockResolvedValue([]),
  },
}));

import { prisma } from "../db";
import { fuelFinderClient } from "../services/fuelFinderClient";
import { runFullIngestion } from "../services/ingestion";

describe("runFullIngestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([]);
    vi.mocked(fuelFinderClient.fetchFuelPrices).mockResolvedValue([]);
    vi.mocked(prisma.station.findMany).mockResolvedValue([]);
    vi.mocked(prisma.fuelPrice.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.priceHistory.findMany).mockResolvedValue([]);
  });

  it("skips permanently closed stations", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([
      {
        node_id: "closed-1",
        permanent_closure: true,
        trading_name: "Closed Station",
        location: { latitude: 51.5, longitude: -0.1, address_line_1: "1 Road", city: "London", postcode: "E1 1AA" },
      },
      {
        node_id: "open-1",
        permanent_closure: false,
        trading_name: "Open Station",
        brand_name: "Shell",
        location: { latitude: 51.6, longitude: -0.2, address_line_1: "2 Road", city: "London", postcode: "E2 2BB" },
      },
    ]);

    await runFullIngestion();

    // Only the open station should be upserted
    expect(prisma.station.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.station.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { govId: "open-1" },
      })
    );
  });

  it("skips stations without coordinates", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([
      {
        node_id: "no-coords",
        trading_name: "No Location Station",
        location: {},
      },
      {
        node_id: "zero-coords",
        trading_name: "Zero Coords",
        location: { latitude: 0, longitude: 0 },
      },
      {
        node_id: "valid-1",
        trading_name: "Valid Station",
        location: { latitude: 51.5, longitude: -0.1, address_line_1: "1 St", city: "London", postcode: "E1 1AA" },
      },
    ]);

    await runFullIngestion();

    // Only the valid station should be upserted
    expect(prisma.station.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.station.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { govId: "valid-1" },
      })
    );
  });

  it("maps station fields correctly: node_id to govId, trading_name to name, etc.", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([
      {
        node_id: "station-abc",
        trading_name: "My Station",
        brand_name: "BP",
        public_phone_number: "01onal23456",
        temporary_closure: true,
        is_motorway_service_station: true,
        is_supermarket_service_station: false,
        amenities: { wifi: true },
        opening_times: { mon: "06:00-22:00" },
        location: {
          latitude: 51.5,
          longitude: -0.1,
          address_line_1: "10 High St",
          address_line_2: "Unit 4",
          city: "London",
          county: "Greater London",
          postcode: "EC1A 1BB",
        },
      },
    ]);

    await runFullIngestion();

    expect(prisma.station.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { govId: "station-abc" },
        create: expect.objectContaining({
          govId: "station-abc",
          name: "My Station",
          brand: "BP",
          phone: "01onal23456",
          temporaryClosure: true,
          isMotorway: true,
          isSupermarket: false,
          addressLine1: "10 High St",
          addressLine2: "Unit 4",
          town: "London",
          county: "Greater London",
          postcode: "EC1A 1BB",
          latitude: 51.5,
          longitude: -0.1,
        }),
      })
    );
  });

  it("filters out prices below 100 or above 500", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([
      {
        node_id: "s1",
        trading_name: "Station",
        location: { latitude: 51.5, longitude: -0.1, address_line_1: "1 St", city: "London", postcode: "E1 1AA" },
      },
    ]);

    vi.mocked(fuelFinderClient.fetchFuelPrices).mockResolvedValue([
      {
        node_id: "s1",
        fuel_prices: [
          { fuel_type: "E10", price: 50, price_last_updated: "2026-04-12T00:00:00Z" },   // too low
          { fuel_type: "E5", price: 145, price_last_updated: "2026-04-12T00:00:00Z" },   // valid
          { fuel_type: "B7_STANDARD", price: 600, price_last_updated: "2026-04-12T00:00:00Z" }, // too high
        ],
      },
    ]);

    // station lookup returns our station
    vi.mocked(prisma.station.findMany).mockResolvedValue([
      { id: 1, govId: "s1" } as any,
    ]);

    await runFullIngestion();

    // Only one valid price should be created (E5 at 145)
    expect(prisma.fuelPrice.create).toHaveBeenCalledTimes(1);
    expect(prisma.fuelPrice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fuelType: "E5",
          pricePence: 145,
          stationId: 1,
        }),
      })
    );
  });

  it("writes a same-price daily snapshot when the price is unchanged and none exists yet today", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([]);
    vi.mocked(fuelFinderClient.fetchFuelPrices).mockResolvedValue([
      {
        node_id: "s1",
        fuel_prices: [{ fuel_type: "E10", price: 145, price_last_updated: "2026-04-12T00:00:00Z" }],
      },
    ]);
    vi.mocked(prisma.station.findMany).mockResolvedValue([{ id: 1, govId: "s1" } as any]);
    vi.mocked(prisma.fuelPrice.findUnique).mockResolvedValue({
      id: 10,
      stationId: 1,
      fuelType: "E10",
      pricePence: 145,
    } as any);
    // No price_history row yet today for this station+fuel
    vi.mocked(prisma.priceHistory.findMany).mockResolvedValue([]);

    await runFullIngestion();

    expect(prisma.fuelPrice.update).not.toHaveBeenCalled();
    expect(prisma.priceHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.priceHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stationId: 1, fuelType: "E10", pricePence: 145 }),
      })
    );
  });

  it("skips the daily snapshot when a price_history row already exists today for that station+fuel", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([]);
    vi.mocked(fuelFinderClient.fetchFuelPrices).mockResolvedValue([
      {
        node_id: "s1",
        fuel_prices: [{ fuel_type: "E10", price: 145, price_last_updated: "2026-04-12T00:00:00Z" }],
      },
    ]);
    vi.mocked(prisma.station.findMany).mockResolvedValue([{ id: 1, govId: "s1" } as any]);
    vi.mocked(prisma.fuelPrice.findUnique).mockResolvedValue({
      id: 10,
      stationId: 1,
      fuelType: "E10",
      pricePence: 145,
    } as any);
    vi.mocked(prisma.priceHistory.findMany).mockResolvedValue([{ stationId: 1, fuelType: "E10" } as any]);

    await runFullIngestion();

    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
  });

  it("still records a real price change even after a same-day snapshot already exists", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([]);
    vi.mocked(fuelFinderClient.fetchFuelPrices).mockResolvedValue([
      {
        node_id: "s1",
        fuel_prices: [{ fuel_type: "E10", price: 150, price_last_updated: "2026-04-12T00:00:00Z" }],
      },
    ]);
    vi.mocked(prisma.station.findMany).mockResolvedValue([{ id: 1, govId: "s1" } as any]);
    vi.mocked(prisma.fuelPrice.findUnique).mockResolvedValue({
      id: 10,
      stationId: 1,
      fuelType: "E10",
      pricePence: 145,
    } as any);
    vi.mocked(prisma.priceHistory.findMany).mockResolvedValue([{ stationId: 1, fuelType: "E10" } as any]);

    await runFullIngestion();

    expect(prisma.fuelPrice.update).toHaveBeenCalledTimes(1);
    expect(prisma.priceHistory.create).toHaveBeenCalledTimes(1);
    expect(prisma.priceHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stationId: 1, fuelType: "E10", pricePence: 150 }),
      })
    );
  });

  it("creates api_call_log entries on success", async () => {
    vi.mocked(fuelFinderClient.fetchStations).mockResolvedValue([]);
    vi.mocked(fuelFinderClient.fetchFuelPrices).mockResolvedValue([]);

    await runFullIngestion();

    // Should have at least two audit log entries: one for stations, one for prices
    expect(prisma.apiCallLog.create).toHaveBeenCalledTimes(2);

    expect(prisma.apiCallLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endpoint: "/api/v1/pfs",
          success: true,
          recordsReturned: 0,
        }),
      })
    );

    expect(prisma.apiCallLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endpoint: "/api/v1/pfs/fuel-prices",
          success: true,
          recordsReturned: 0,
        }),
      })
    );
  });
});
