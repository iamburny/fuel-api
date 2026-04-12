function safeJsonParse(val: string | null | undefined): any {
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

export function stationDto(s: any) {
  return {
    id: s.id,
    gov_id: s.govId,
    name: s.name,
    brand: s.brand,
    operator: s.operator,
    phone: s.phone ?? null,
    address_line1: s.addressLine1,
    address_line2: s.addressLine2 ?? null,
    town: s.town,
    county: s.county ?? null,
    postcode: s.postcode,
    latitude: s.latitude,
    longitude: s.longitude,
    temporary_closure: s.temporaryClosure ?? false,
    is_motorway: s.isMotorway ?? false,
    is_supermarket: s.isSupermarket ?? false,
    amenities: safeJsonParse(s.amenities),
    opening_hours: safeJsonParse(s.openingHours),
  };
}

export function priceDto(p: any) {
  return {
    fuel_type: p.fuelType,
    price_pence: p.pricePence,
    reported_at: p.reportedAt,
  };
}
