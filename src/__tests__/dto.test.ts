import { stationDto, priceDto } from "../dto";

describe("stationDto", () => {
  const fullStation = {
    id: 1,
    govId: "abc123",
    name: "Shell Testville",
    brand: "Shell",
    operator: "Shell UK",
    phone: "01onal234567",
    addressLine1: "1 High Street",
    addressLine2: "Unit 5",
    town: "Testville",
    county: "Testshire",
    postcode: "TE1 1ST",
    latitude: 51.5,
    longitude: -0.1,
    temporaryClosure: true,
    isMotorway: true,
    isSupermarket: false,
    amenities: '{"wifi": true, "toilet": true}',
    openingHours: '{"mon": "06:00-22:00"}',
  };

  it("maps a full Prisma station object correctly", () => {
    const dto = stationDto(fullStation);

    expect(dto.id).toBe(1);
    expect(dto.gov_id).toBe("abc123");
    expect(dto.name).toBe("Shell Testville");
    expect(dto.brand).toBe("Shell");
    expect(dto.operator).toBe("Shell UK");
    expect(dto.phone).toBe("01onal234567");
    expect(dto.address_line1).toBe("1 High Street");
    expect(dto.address_line2).toBe("Unit 5");
    expect(dto.town).toBe("Testville");
    expect(dto.county).toBe("Testshire");
    expect(dto.postcode).toBe("TE1 1ST");
    expect(dto.latitude).toBe(51.5);
    expect(dto.longitude).toBe(-0.1);
    expect(dto.temporary_closure).toBe(true);
    expect(dto.is_motorway).toBe(true);
    expect(dto.is_supermarket).toBe(false);
    expect(dto.amenities).toEqual({ wifi: true, toilet: true });
    expect(dto.opening_hours).toEqual({ mon: "06:00-22:00" });
  });

  it("handles null/undefined optional fields", () => {
    const minimal = {
      id: 2,
      govId: "def456",
      name: "BP Minimal",
      brand: "BP",
      operator: null,
      addressLine1: "2 Low Road",
      town: "Mintown",
      postcode: "MI1 1NI",
      latitude: 52.0,
      longitude: -1.0,
      // phone, addressLine2, county, temporaryClosure, isMotorway, isSupermarket all missing
      amenities: null,
      openingHours: undefined,
    };

    const dto = stationDto(minimal);

    expect(dto.phone).toBeNull();
    expect(dto.address_line2).toBeNull();
    expect(dto.county).toBeNull();
    expect(dto.amenities).toBeNull();
    expect(dto.opening_hours).toBeNull();
  });

  it("parses valid JSON amenities string into object", () => {
    const station = { ...fullStation, amenities: '["atm","car_wash"]' };
    const dto = stationDto(station);
    expect(dto.amenities).toEqual(["atm", "car_wash"]);
  });

  it("returns null for malformed JSON", () => {
    const station = { ...fullStation, amenities: "{not valid json", openingHours: "nope" };
    const dto = stationDto(station);
    expect(dto.amenities).toBeNull();
    expect(dto.opening_hours).toBeNull();
  });

  it("defaults booleans to false when undefined", () => {
    const station = {
      id: 3,
      govId: "ghi789",
      name: "Test",
      brand: "Test",
      operator: null,
      addressLine1: "3 Road",
      town: "Town",
      postcode: "T1 1T",
      latitude: 50,
      longitude: 0,
      // temporaryClosure, isMotorway, isSupermarket all undefined
    };
    const dto = stationDto(station);
    expect(dto.temporary_closure).toBe(false);
    expect(dto.is_motorway).toBe(false);
    expect(dto.is_supermarket).toBe(false);
  });
});

describe("priceDto", () => {
  it("maps correctly", () => {
    const reportedAt = new Date("2026-04-12T10:00:00Z");
    const dto = priceDto({
      fuelType: "E10",
      pricePence: 145.9,
      reportedAt,
    });

    expect(dto.fuel_type).toBe("E10");
    expect(dto.price_pence).toBe(145.9);
    expect(dto.reported_at).toBe(reportedAt);
  });
});
