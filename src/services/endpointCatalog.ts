/**
 * Hand-maintained catalog of the public fuel-api surface, served at
 * GET /api/admin/endpoints so the fuel-admin "API tester" can render a request
 * builder (pick endpoint → fill params → run, optionally as an impersonated user).
 *
 * Keep this in sync when routes change. It intentionally documents the
 * client-facing endpoints (stations/prices/auth/favourites/discrepancy), not the
 * admin console's own endpoints.
 */

export interface EndpointParam {
  name: string;
  in: "query" | "path" | "body";
  required?: boolean;
  description?: string;
  example?: string;
}

export interface EndpointDoc {
  group: string;
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  description: string;
  auth?: "none" | "user"; // "user" endpoints need a bearer token (use impersonation)
  params?: EndpointParam[];
}

export const API_ENDPOINT_CATALOG: EndpointDoc[] = [
  {
    group: "Stations",
    method: "GET",
    path: "/api/stations/nearby",
    description: "Stations near a point, distance-sorted, with prices.",
    auth: "none",
    params: [
      { name: "lat", in: "query", required: true, example: "51.5074" },
      { name: "lng", in: "query", required: true, example: "-0.1278" },
      { name: "radius", in: "query", example: "10" },
      { name: "fuel_type", in: "query", example: "E10" },
      { name: "limit", in: "query", example: "20" },
    ],
  },
  {
    group: "Stations",
    method: "GET",
    path: "/api/stations/bounds",
    description: "Stations within a lat/lng bounding box (map viewport).",
    auth: "none",
    params: [
      { name: "minLat", in: "query", required: true },
      { name: "maxLat", in: "query", required: true },
      { name: "minLng", in: "query", required: true },
      { name: "maxLng", in: "query", required: true },
      { name: "fuel_type", in: "query" },
      { name: "limit", in: "query" },
    ],
  },
  {
    group: "Stations",
    method: "GET",
    path: "/api/stations/search",
    description: "Search stations by name/postcode/brand/town (min 2 chars).",
    auth: "none",
    params: [
      { name: "q", in: "query", required: true, example: "shell" },
      { name: "limit", in: "query" },
    ],
  },
  {
    group: "Stations",
    method: "GET",
    path: "/api/stations/:id",
    description: "Station detail with current prices.",
    auth: "none",
    params: [{ name: "id", in: "path", required: true, example: "1" }],
  },
  {
    group: "Prices",
    method: "GET",
    path: "/api/prices/cheapest",
    description: "Cheapest stations for a fuel type, optionally near a point.",
    auth: "none",
    params: [
      { name: "fuel_type", in: "query", example: "E10" },
      { name: "lat", in: "query" },
      { name: "lng", in: "query" },
      { name: "radius", in: "query" },
      { name: "limit", in: "query" },
    ],
  },
  {
    group: "Prices",
    method: "GET",
    path: "/api/prices/averages",
    description: "National average/min/max/count per fuel type.",
    auth: "none",
  },
  {
    group: "Prices",
    method: "GET",
    path: "/api/prices/history/:stationId",
    description: "Price history for one station.",
    auth: "none",
    params: [
      { name: "stationId", in: "path", required: true, example: "1" },
      { name: "fuel_type", in: "query", example: "E10" },
      { name: "days", in: "query", example: "30" },
    ],
  },
  {
    group: "Prices",
    method: "GET",
    path: "/api/prices/trends",
    description: "Daily national average trend series.",
    auth: "none",
    params: [
      { name: "fuel_type", in: "query", example: "E10" },
      { name: "days", in: "query", example: "30" },
    ],
  },
  {
    group: "Auth",
    method: "POST",
    path: "/api/auth/login",
    description: "Log in; returns a bearer token.",
    auth: "none",
    params: [
      { name: "username", in: "body", required: true, description: "email" },
      { name: "password", in: "body", required: true },
    ],
  },
  {
    group: "Favourites",
    method: "GET",
    path: "/api/favourites",
    description: "List the authenticated user's favourites.",
    auth: "user",
  },
  {
    group: "Favourites",
    method: "POST",
    path: "/api/favourites",
    description: "Add a favourite station.",
    auth: "user",
    params: [
      { name: "station_id", in: "body", required: true },
      { name: "fuel_type", in: "body" },
      { name: "notify_on_drop", in: "body" },
      { name: "price_threshold_pence", in: "body" },
    ],
  },
  {
    group: "Favourites",
    method: "DELETE",
    path: "/api/favourites/:id",
    description: "Remove a favourite.",
    auth: "user",
    params: [{ name: "id", in: "path", required: true }],
  },
  {
    group: "Discrepancy",
    method: "POST",
    path: "/api/discrepancy",
    description: "Submit a price-discrepancy report.",
    auth: "none",
    params: [
      { name: "description", in: "body", required: true },
      { name: "station_id", in: "body" },
      { name: "fuel_type", in: "body" },
      { name: "reported_price_pence", in: "body" },
      { name: "expected_price_pence", in: "body" },
    ],
  },
];
