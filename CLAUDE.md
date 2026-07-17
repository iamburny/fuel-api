# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server with tsx watch (hot reload), loads .env via --env-file
npm run build        # tsc → dist/
npm start            # Run compiled dist/index.js (also loads .env via --env-file)
npm run db:push      # Push Prisma schema to DB (SQLite dev)
npm run db:migrate   # Create + apply a migration (prod/Postgres workflow)
npm run db:generate  # Regenerate Prisma client after schema.prisma edits
npm run db:studio    # Open Prisma Studio GUI
npm run test         # Vitest (unit tests in src/__tests__/*.test.ts)
```

Tests run under Vitest; `geo.test.ts` mocks Prisma and forces the SQLite code path (`isPostgres()` → false). No linter or formatter is configured. After editing `prisma/schema.prisma`, always run `db:generate` (and `db:push` for dev) before the TypeScript will compile against the new types.

Manual ingestion during development: `POST /api/admin/ingest` triggers `runFullIngestion()` on demand — useful when you don't want to wait for the 5-minute cron.

## Architecture

This is an Express + Prisma service that ingests data from the UK Government Fuel Finder API on a schedule and re-serves it to clients (web and Android). Three things to understand before making changes:

### 1. Ingestion is the core loop

`src/index.ts` boots Express **and** a `node-cron` scheduler that runs `runFullIngestion()` every N minutes. The flow is:

`fuelFinderClient.fetchStations()` → upsert `Station` by `govId` (upstream `node_id`) → `fuelFinderClient.fetchFuelPrices()` → resolve `node_id` → `station.id` via in-memory map → upsert `FuelPrice` (current) **and** append to `PriceHistory` on a real price change, **or** once per calendar day per (station, fuel) even when the price is unchanged — a same-price snapshot, stamped with the ingestion time (not the upstream `reportedAt`), so `/api/prices/history/*` always has at least one point per day instead of gaps as long as a price sits still. The "already snapshotted today" check queries `PriceHistory` for rows with `fetchedAt` on today's date once per ingestion cycle (not per row).

`FuelPrice` has a `@@unique([stationId, fuelType])` — there is exactly one row per (station, fuel) representing the latest known price. `PriceHistory` is append-only and drives `/api/prices/history/*` and `/trends`. Any change to ingestion must preserve this split.

Permanently closed stations and stations without coordinates are skipped during ingestion.

### 2. Upstream Gov Fuel Finder API

The upstream base URL is `https://www.fuel-finder.service.gov.uk` (default in `config.ts`). Full API docs: `docs/api.md` § 8, and the developer portal at `https://www.developer.fuel-finder.service.gov.uk/`.

**Authentication:** OAuth 2.0 client-credentials. `POST /api/v1/oauth/generate_access_token` with JSON body `{client_id, client_secret}`. Response is `{success, data: {access_token, refresh_token, expires_in}}` — note the nested `data` wrapper. Token refresh endpoint is at `/api/v1/oauth/regenerate_access_token`.

**Data endpoints:**
- `GET /api/v1/pfs?batch-number=N` — station info (500 per batch, response is flat JSON array)
- `GET /api/v1/pfs/fuel-prices?batch-number=N` — fuel prices (flat JSON array)
- Both accept optional `effective-start-timestamp=YYYY-MM-DD` for delta sync (not yet used)

**Pagination:** uses `batch-number` (1-indexed, 500 items per batch). **NOT** `page`/`per_page` — the API rejects unknown query params with a 400.

**Rate limits:** 30 RPM, 1 concurrent request per client. The sequential `await` pattern in `fetchPaginated` naturally satisfies the concurrency limit.

**Response shapes differ between success and error.** Successful responses are a flat JSON array `[{...}, ...]`. Errors are wrapped: `{success: false, data: {...}, message: ..., error: {...}}` (sometimes double-wrapped by the gateway).

**Key upstream field names:**
- Station ID: `node_id` (hex hash string, stored as `govId` in Prisma)
- Station name: `trading_name`
- Brand: `brand_name`
- Location: `location.latitude`, `location.longitude`, `location.address_line_1`, `location.city`, `location.postcode`, etc.
- Opening hours: `opening_times` (not `opening_hours`)
- Price entries: nested in `fuel_prices[]` array per station, each with `fuel_type`, `price`, `price_last_updated`, `price_change_effective_timestamp`

### 3. Fuel type identifiers

Fuel types are passed through from the upstream API unchanged:

| Identifier | Description |
|---|---|
| `E10` | Unleaded (10% bioethanol) — standard petrol |
| `E5` | Super unleaded (5% bioethanol) |
| `B7_STANDARD` | Standard diesel |
| `B7_PREMIUM` | Premium diesel |
| `B10` | Biodiesel |
| `HVO` | Hydrotreated vegetable oil diesel |

These are the exact strings stored in the database and returned by all API endpoints. Do not normalise, remap, or introduce aliases — the web frontend (`fuel-web`) relies on these exact values for `FUEL_LABELS`, `FUEL_COLORS`, and `FuelType` union matching.

### 4. Compliance is load-bearing, not cosmetic

This service operates under the Gov Fair Use Policy and that constrains the code in specific ways:

- **Poll interval is clamped.** `config.ts` caps `POLL_INTERVAL_MINUTES` at 5 during env load, and `index.ts` clamps again before scheduling. Don't remove either clamp.
- **Every Gov API call is audit-logged** to `api_call_log` — both success and failure branches in `ingestion.ts` write a row. New upstream calls must also log.
- **Price responses must include the compliance footer** from `services/compliance.ts` (discrepancy URL + data-source notice). Routes under `/api/prices` and `/api/stations` that return prices should spread `complianceFooter()` into the response.
- **No brand filtering or price modification.** Prices pass through unchanged with their original `reportedAt` timestamp.
- `/api/admin/compliance/*` exposes the audit trail; `/api/discrepancy/` captures user-reported data issues.

### 5. Geo queries are dialect-aware (Postgres raw SQL vs SQLite JS)

`services/geo.ts` is the only place that does distance math, and it branches on `isPostgres()` (from `db.ts`, reads `DATABASE_URL`):

- **Postgres (prod):** `findNearbyStations` / `findCheapest` run a single `$queryRaw` that computes haversine distance in SQL, filters by the bounding box + exact radius, and applies `ORDER BY distance LIMIT $limit` **in the DB** — then a second scoped query fetches prices only for the winning station ids (keeps the DTO-shaping code unchanged). No over-fetching.
- **SQLite (dev):** no trig in SQL, so it keeps the bounding-box pre-filter + JS haversine/sort/slice, but caps the candidate rows fetched (`SQLITE_CANDIDATE_CAP`) so a wide radius can't pull unbounded rows. This can, in a pathological dense-area case, drop results beyond the cap — an accepted dev-only trade-off.

`findStationsInBounds` (powers `GET /api/stations/bounds`) is a plain indexed bounding-box query with a DB-side `LIMIT` — no haversine on either dialect, since a box has no origin point to measure from. `/api/prices/trends` likewise groups by date in SQL (`to_char` on Postgres, `strftime` on SQLite) rather than fetching all rows and grouping in JS. Reuse these helpers rather than rolling new distance/aggregation logic in route handlers.

## Database

SQLite for dev (`file:./fuel.db`, auto-created), PostgreSQL for prod. Switching requires editing `prisma/schema.prisma`'s `provider` **and** updating `DATABASE_URL` — the provider is hardcoded, not env-driven. Use `db:push` for dev, `db:migrate` for prod.

`Station.amenities` and `Station.openingHours` are stored as JSON strings (SQLite has no native JSON type) — parse on read if you need structured access.

## Config

All env vars are validated by Zod in `src/config.ts` and exported as the typed `env` object. Add new settings there, not via `process.env` directly. `.env` is loaded at startup via Node's `--env-file=.env` flag in the npm scripts (not dotenv). Missing/invalid env exits the process at startup.

## Client API reference

Full endpoint documentation for web and Android clients is in `docs/api.md`, including request/response shapes, query parameters, auth flow (JWT), and the upstream data field reference.
