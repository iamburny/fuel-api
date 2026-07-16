# UK Fuel Prices API — Client Reference

Reference for Android and Web client developers consuming the Fuel Prices API.

All data originates from the [UK Government Fuel Finder](https://www.developer.fuel-finder.service.gov.uk/) service and is re-served to clients through this API under the Open Government Licence.

---

## 1. Base URL & environments

| Environment | Base URL |
|---|---|
| Local dev | `http://localhost:8000` (emulator → host: `http://10.0.2.2:8000`) |
| Production | `https://api.fueltracker.uk` |

All endpoints are prefixed with `/api`.

## 2. Authentication

Two classes of endpoint:

- **Public** — no auth required. All read endpoints (stations, prices, discrepancy form).
- **Authenticated** — require a JWT in `Authorization: Bearer <token>`. Used for favourites and user-specific state.

### Obtaining a token

```http
POST /api/auth/register
Content-Type: application/json

{"email": "user@example.com", "password": "correct-horse-battery-staple"}
```

```http
POST /api/auth/login
Content-Type: application/json

{"email": "user@example.com", "password": "correct-horse-battery-staple"}
```

Login responds with:
```json
{"access_token": "eyJhbGci...", "token_type": "bearer"}
```

`POST /api/auth/login` also accepts form-encoded `username` + `password` for OAuth2-password-flow compatibility.

Tokens expire after the server-configured TTL (default 24h). On 401 responses, redirect the user to re-login.

## 3. Fuel type identifiers

These are the exact strings used in all query parameters and response fields. They come directly from the upstream Gov Fuel Finder API and are **case-sensitive**:

| Identifier | Description |
|---|---|
| `E10` | E10 unleaded (10% bioethanol) — standard petrol |
| `E5` | E5 unleaded (5% bioethanol) — premium petrol |
| `B7_STANDARD` | B7 standard diesel (7% biodiesel) |
| `B7_PREMIUM` | B7 premium diesel |
| `B10` | B10 biodiesel (10% biodiesel) |
| `HVO` | Hydrotreated vegetable oil diesel |

Clients should treat this as a fixed enum. If the upstream service adds a new fuel type it will pass through unchanged; unknown values should be rendered verbatim rather than silently filtered.

## 4. Error format

On error, endpoints return a JSON body of the shape:
```json
{"detail": "human-readable description"}
```

| Status | Meaning |
|---|---|
| 400 | Missing or invalid query/body parameter |
| 401 | Missing/invalid/expired JWT (authenticated endpoints) |
| 404 | Resource not found (e.g. station id) |
| 409 | Conflict (e.g. registering an email that already exists) |

## 5. Public endpoints

### 5.1 Stations

#### `GET /api/stations/nearby`

Find stations within a radius of a location, sorted by distance.

| Query param | Type | Default | Notes |
|---|---|---|---|
| `lat` | number | _required_ | Latitude in decimal degrees |
| `lng` | number | _required_ | Longitude in decimal degrees |
| `radius` | number | `10` | Miles |
| `fuel_type` | string | _(all)_ | If provided, only the matching price row is included per station |
| `limit` | number | `20` | Max 500 |

**Response:**
```json
{
  "count": 2,
  "stations": [
    {
      "id": 431,
      "gov_id": "9b275ab576eeba3c...",
      "name": "SuperFuel Loughborough",
      "brand": "SuperFuel",
      "operator": null,
      "address_line1": "14 London Road",
      "town": "Loughborough",
      "postcode": "LE11 9AA",
      "latitude": 52.767,
      "longitude": -1.207,
      "distance_miles": 0.42,
      "prices": [
        {"fuel_type": "E10", "price_pence": 143.9, "reported_at": "2026-04-11T09:14:00.000Z"},
        {"fuel_type": "E5", "price_pence": 149.9, "reported_at": "2026-04-11T09:14:00.000Z"}
      ]
    }
  ]
}
```

#### `GET /api/stations/bounds`

Stations within an exact lat/lng bounding box — for loading map pins as the user pans/zooms a map viewport. Unlike `/nearby`, there is no origin point, so results are **not** distance-sorted and carry no `distance_miles`.

| Query param | Type | Default | Notes |
|---|---|---|---|
| `minLat` | number | _required_ | South edge of the box |
| `maxLat` | number | _required_ | North edge of the box |
| `minLng` | number | _required_ | West edge of the box |
| `maxLng` | number | _required_ | East edge of the box |
| `fuel_type` | string | _(all)_ | If provided, only the matching price row is included per station |
| `limit` | number | `100` | Max 500 |

Response shape is the same as `/nearby` but without `distance_miles`. Returns `400` if any of the four bounds is missing or non-numeric.

#### `GET /api/stations/search`

Full-text search by station name, brand, town, or postcode.

| Query param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | _required_ | Minimum 2 characters |
| `limit` | number | `20` | Max 100 |

Response shape is the same as `/nearby` but without `distance_miles`.

#### `GET /api/stations/:id`

Full detail for a single station. `:id` is the local database id (the `id` field returned by `/nearby` and `/search`), **not** `gov_id`.

Returns a single station object (same shape as above, no `distance_miles`).

### 5.2 Prices

#### `GET /api/prices/cheapest`

Cheapest prices for a given fuel type, optionally within a radius.

| Query param | Type | Default | Notes |
|---|---|---|---|
| `fuel_type` | string | `E10` | See fuel type enum above |
| `lat` | number | _(optional)_ | If omitted, returns cheapest nationwide |
| `lng` | number | _(optional)_ | Required when `lat` is provided |
| `radius` | number | `10` | Miles — ignored if no `lat`/`lng` |
| `limit` | number | `10` | Max 500 |

**Response:**
```json
{
  "results": [
    {
      "station": { /* same 10-field station shape as /stations/nearby */ },
      "price_pence": 139.9,
      "distance_miles": 1.23
    }
  ],
  "discrepancy_report_url": "https://www.fuel-finder.service.gov.uk/report-discrepancy",
  "data_notice": "Prices are sourced from the UK Government Fuel Finder scheme under the Open Government Licence. Data is presented without modification."
}
```

`distance_miles` is `null` when no location was provided.

#### `GET /api/prices/averages`

National aggregate stats per fuel type.

**Response:**
```json
{
  "averages": [
    {
      "fuel_type": "E10",
      "avg_price_pence": 143.72,
      "min_price_pence": 129.9,
      "max_price_pence": 167.9,
      "station_count": 8421,
      "as_of": "2026-04-11T12:00:00.000Z"
    }
  ],
  "discrepancy_report_url": "...",
  "data_notice": "..."
}
```

#### `GET /api/prices/history/:stationId`

Price history for a specific station + fuel type.

| Query param | Type | Default | Notes |
|---|---|---|---|
| `fuel_type` | string | `E10` | |
| `days` | number | `30` | Max 365 |

**Response:**
```json
{
  "station_id": 431,
  "station_name": "SuperFuel Loughborough",
  "fuel_type": "E10",
  "history": [
    {"price_pence": 141.9, "reported_at": "2026-03-12T06:00:00.000Z"},
    {"price_pence": 142.9, "reported_at": "2026-03-15T08:30:00.000Z"}
  ]
}
```

History rows are only created when the price actually changes — don't expect one row per day.

#### `GET /api/prices/trends`

National daily trend for a fuel type.

| Query param | Type | Default | Notes |
|---|---|---|---|
| `fuel_type` | string | `E10` | |
| `days` | number | `30` | Max 365 |

**Response:**
```json
{
  "trend": [
    {
      "date": "2026-04-10",
      "avg_price_pence": 143.58,
      "min_price_pence": 129.9,
      "max_price_pence": 167.9,
      "observations": 12904
    }
  ],
  "discrepancy_report_url": "...",
  "data_notice": "..."
}
```

### 5.3 Discrepancy reporting

#### `GET /api/discrepancy/report-url`

Returns the official Gov Fuel Finder discrepancy report URL that clients **must** expose in their UI (Fair Use Policy requirement).

```json
{
  "url": "https://www.fuel-finder.service.gov.uk/report-discrepancy",
  "message": "Report incorrect fuel prices directly to the Government Fuel Finder service."
}
```

#### `POST /api/discrepancy`

Capture a user-submitted discrepancy report. `description` is the only required field.

```json
{
  "station_id": 431,
  "fuel_type": "E10",
  "reported_price_pence": 139.9,
  "expected_price_pence": 145.9,
  "description": "Price at pump differs from app",
  "reporter_email": "user@example.com"
}
```

Responds `201` with the created report id.

## 6. Authenticated endpoints

All endpoints below require `Authorization: Bearer <jwt>`.

### 6.1 Favourites

#### `GET /api/favourites`

List the authenticated user's favourite stations.

```json
[
  {
    "id": 12,
    "station_id": 431,
    "fuel_type": "E10",
    "notify_on_drop": true,
    "price_threshold_pence": 140.0,
    "station": {
      "id": 431,
      "gov_id": "9b275ab576eeba3c...",
      "name": "SuperFuel Loughborough",
      "brand": "SuperFuel",
      "latitude": 52.767,
      "longitude": -1.207
    }
  }
]
```

#### `POST /api/favourites`

Add a favourite.

```json
{
  "station_id": 431,
  "fuel_type": "E10",
  "notify_on_drop": true,
  "price_threshold_pence": 140.0
}
```

`409` if the station is already a favourite for this user.

#### `DELETE /api/favourites/:id`

Remove a favourite. `204` on success.

### 6.2 Push notifications

#### `POST /api/auth/fcm-token`

Register a Firebase Cloud Messaging token for push notifications (e.g. price drop alerts on favourites).

```json
{"fcm_token": "eXaMPle:APA91..."}
```

Also accepts `?fcm_token=...` as a query parameter.

## 7. Data models (reference)

The fields below describe the **stored** shape. Current DTOs expose a subset (see §5.1). Future endpoint revisions may surface more.

### Station

| Field | Type | Notes |
|---|---|---|
| `id` | int | Local DB id — use this to reference a station in other endpoints |
| `gov_id` | string | Gov `node_id` (hex hash) — stable across ingestions |
| `name` | string | From upstream `trading_name` |
| `brand` | string? | From upstream `brand_name` |
| `operator` | string? | Currently always `null` |
| `address_line1` / `address_line2` | string? | |
| `town` | string? | From upstream `location.city` |
| `county` | string? | |
| `postcode` | string? | UK postcode |
| `latitude` / `longitude` | float | WGS84 decimal degrees. Stations without coordinates are excluded during ingestion |
| `amenities` | JSON string | See §8 for inner shape |
| `opening_hours` | JSON string | See §8 for inner shape |
| `last_updated` | timestamp | When this row was last ingested |

### FuelPrice (current)

One row per `(station, fuel_type)` — always the latest known price.

| Field | Type |
|---|---|
| `station_id` | int |
| `fuel_type` | string (see enum) |
| `price_pence` | float (e.g. `143.9` = £1.439/litre) |
| `reported_at` | timestamp — when the retailer reported the change |
| `fetched_at` | timestamp — when we ingested it |

### PriceHistory (append-only)

Same fields as `FuelPrice`, but a new row is appended each time a price changes. Drives `/api/prices/history/*` and `/api/prices/trends`.

### Favourite

See §6.1 — one row per `(user, station)` unique pair.

## 8. Upstream data reference

The following fields are present in the upstream Gov Fuel Finder response but are **not yet exposed** in our DTOs. Client requests for additional fields should reference these names.

### Station (`location` block)

```
location.address_line_1       string
location.address_line_2       string
location.city                 string
location.country              string   e.g. "England"
location.county               string
location.postcode             string
location.latitude             number
location.longitude            number
```

### Station flags

```
is_same_trading_and_brand_name    boolean
temporary_closure                 boolean
permanent_closure                 boolean   — closed stations are filtered out during ingestion
permanent_closure_date            ISO-8601 | null
is_motorway_service_station       boolean
is_supermarket_service_station    boolean
```

### Amenities

```
amenities.adblue_pumps             boolean
amenities.adblue_packaged          boolean
amenities.lpg_pumps                boolean
amenities.car_wash                 boolean
amenities.air_pump_or_screenwash   boolean
amenities.water_filling            boolean
amenities.twenty_four_hour_fuel    boolean
amenities.customer_toilets         boolean
```

### Opening times

```
opening_times.usual_days.{monday..sunday}.open          "HH:MM"
opening_times.usual_days.{monday..sunday}.close         "HH:MM"
opening_times.usual_days.{monday..sunday}.is_24_hours   boolean
opening_times.bank_holidays[].type                      string
opening_times.bank_holidays[].open_time                 "HH:MM"
opening_times.bank_holidays[].close_time                "HH:MM"
opening_times.bank_holidays[].is_24_hours               boolean
```

When `is_24_hours` is `true`, the `open` / `close` times should be ignored — the forecourt is open continuously that day.

### Fuel types availability

```
fuel_types.E10           boolean
fuel_types.E5            boolean
fuel_types.B7_STANDARD   boolean
fuel_types.B7_PREMIUM    boolean
fuel_types.B10           boolean
fuel_types.HVO           boolean
```

This tells you which fuels a station sells — useful for greying out unavailable filters in the UI.

### Prices

Each station in the prices feed has an inner `fuel_prices[]` array:

```
fuel_prices[].fuel_type                          string (see enum)
fuel_prices[].price                              number (pence)
fuel_prices[].price_last_updated                 ISO-8601
fuel_prices[].price_change_effective_timestamp   ISO-8601
```

`price_last_updated` is when the retailer reported the change. `price_change_effective_timestamp` is when the new price took effect at the pump. We use `price_last_updated` as `reported_at` in our responses.

## 9. Fair Use Policy — client obligations

This service operates under the Gov Fuel Finder Fair Use Policy. **Client apps must:**

1. **Display the discrepancy report URL** in any screen that shows fuel prices. The URL is returned in the `discrepancy_report_url` field on `/api/prices/*` responses, or fetchable once from `/api/discrepancy/report-url`.
2. **Show prices unmodified** with their `reported_at` timestamps. Do not round, re-average, or relabel them.
3. **Attribute the data source**: include text like *"Prices sourced from the UK Government Fuel Finder scheme under the Open Government Licence"* (the server also returns this as `data_notice` for convenience).
4. **Do not filter or re-rank by brand** beyond what the user has explicitly requested.
5. **Capture user complaints** and submit them via `POST /api/discrepancy`, which feeds the audit trail.

Failure to comply may result in credentials being revoked by the upstream service.

## 10. Ingestion cadence

The server polls the Gov Fuel Finder API every 5 minutes. Price data you receive from this API is at most ~5 minutes stale from upstream, plus however long it takes retailers to report changes to the Gov service. Clients should not poll this API more frequently than once per minute per screen.

---

_Last updated to reflect the Fuel Finder Information Recipient API schema (batch-number pagination, `node_id` station identifier, `E10 / E5 / B7_STANDARD / B7_PREMIUM / B10 / HVO` fuel type enum)._
