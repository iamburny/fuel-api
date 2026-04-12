# UK Fuel Prices API (Node.js / TypeScript)

Backend service that ingests data from the [UK Government Fuel Finder API](https://www.developer.fuel-finder.service.gov.uk/) and serves it to web and mobile clients.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your Fuel Finder API credentials

npm install
npx prisma db push      # Create database tables
npm run dev              # Start dev server with hot reload
```

Visit `http://localhost:8000/api/health` to confirm it's running.

## Tech Stack

- **Express** + **TypeScript** — REST API
- **Prisma** ORM — SQLite for dev, PostgreSQL for prod
- **node-cron** — scheduled polling of Gov API every 5 minutes
- **Zod** — environment variable validation
- **bcryptjs** + **jsonwebtoken** — user auth
- **Native fetch** — Gov API client (Node 22+)

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/stations/nearby?lat=&lng=&radius=` | Nearest stations with prices |
| `GET /api/stations/:id` | Station detail |
| `GET /api/stations/search?q=` | Search by name/postcode/brand |
| `GET /api/prices/cheapest?fuel_type=E10&lat=&lng=` | Cheapest nearby |
| `GET /api/prices/averages` | National averages per fuel type |
| `GET /api/prices/history/:stationId` | Price history for a station |
| `GET /api/prices/trends?fuel_type=E10&days=30` | National daily trend |
| `POST /api/auth/register` | Create account |
| `POST /api/auth/login` | Get JWT token |
| `GET/POST/DELETE /api/favourites/` | Manage saved stations |
| `POST /api/discrepancy/` | Report incorrect price data |
| `GET /api/admin/compliance/stats` | Fair Use Policy compliance stats |
| `GET /api/admin/compliance/call-log` | API call audit trail |
| `POST /api/admin/ingest` | Manually trigger ingestion |

## Database

### Development (SQLite)
No setup needed — Prisma creates the file automatically.

### Production (PostgreSQL)
```bash
# Update .env
DATABASE_URL="postgresql://fuel:secret@localhost:5432/fueldb"

# Update prisma/schema.prisma provider to "postgresql"
# Then push or migrate
npx prisma migrate dev --name init
```

## Compliance

This service operates under the [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/) and the Fuel Finder Aggregator Fair Use Policy:

- Polls at ≤ 5 minute intervals (enforced in code, clamped at startup)
- All API calls are audit-logged (`api_call_log` table)
- Prices are presented unmodified with original timestamps
- Every price response includes the Gov discrepancy report URL
- User complaints are captured via `/api/discrepancy/`
- No brand-boosting or selective filtering

## Deployment

```bash
# Docker
docker build -t fuel-api .
docker run -p 8000:8000 --env-file .env fuel-api

# Or build and run directly
npm run build
NODE_ENV=production node dist/index.js
```

## Project Structure

```
src/
├── index.ts               → Express app + cron scheduler
├── config.ts              → Zod-validated env config
├── db.ts                  → Prisma client singleton
├── services/
│   ├── fuelFinderClient.ts → OAuth token lifecycle + paginated fetch
│   ├── ingestion.ts        → Upsert stations/prices + audit log
│   ├── geo.ts              → Haversine distance queries
│   ├── auth.ts             → JWT/bcrypt + requireAuth middleware
│   └── compliance.ts       → Response footer helper
└── routes/
    ├── stations.ts         → /nearby, /search, /:id
    ├── prices.ts           → /cheapest, /averages, /history, /trends
    ├── auth.ts             → /register, /login, /fcm-token
    ├── favourites.ts       → CRUD (authenticated)
    ├── discrepancy.ts      → Report + list
    └── compliance.ts       → /stats, /call-log (admin)
```
