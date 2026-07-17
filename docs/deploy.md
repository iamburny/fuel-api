# Deployment Guide — Fuel Tracker

Self-hosted deployment of the Fuel API and Web app on a Linux server running Docker with Traefik reverse proxy.

## Architecture

```
Internet
  │
  ├── fueltracker.uk ──────► Traefik ──► fuel-web  (Next.js, port 3000)
  └── api.fueltracker.uk ──► Traefik ──► fuel-api  (Express, port 8000)
                                              │
                                              └──► fuel-db (PostgreSQL 17, port 5432)
```

- **fuel-api** — Express + Prisma, ingests Gov Fuel Finder data on a 30-minute cron, serves REST API
- **fuel-web** — Next.js frontend, calls the API client-side via `https://api.fueltracker.uk`
- **fuel-db** — PostgreSQL 17 (Alpine), persistent named volume
- **Traefik** — existing shared instance on the `home` Docker network, handles TLS via Let's Encrypt

## Prerequisites

- Docker and Docker Compose installed
- Traefik running on the `home` Docker network with HTTPS entrypoint and a cert resolver named `myresolver`
- DNS A records pointing `fueltracker.uk`, `www.fueltracker.uk`, and `api.fueltracker.uk` to your server
- Gov Fuel Finder API credentials from https://www.developer.fuel-finder.service.gov.uk/

## 1. Deploy the API

```bash
# Clone and enter the repo
cd ~/
git clone <fuel-api-repo-url> fuel-api
cd fuel-api

# Create production env file
cp .env.production.example .env.production
```

Edit `.env.production`:

```env
POSTGRES_PASSWORD=<strong-random-password>
DATABASE_URL=postgresql://fuel:<same-password-as-above>@fuel-db:5432/fueldb
FUEL_FINDER_CLIENT_ID=<your-client-id>
FUEL_FINDER_CLIENT_SECRET=<your-client-secret>
POLL_INTERVAL_MINUTES=30
JWT_SECRET=<long-random-string>
```

`DATABASE_URL` must be set explicitly here and kept in sync with `POSTGRES_PASSWORD` — it is **not** derived automatically from anything in `docker-compose.yml`.

Build and start:

```bash
docker compose up -d --build
```

This starts two containers:

| Container | Image | Purpose |
|---|---|---|
| `fuel-db` | postgres:17-alpine | Database, data in `fuel-pgdata` volume |
| `fuel-api` | Built from Dockerfile | API server, waits for DB health check |

On first start, `prisma db push` creates the tables automatically, then the initial data ingestion runs. This takes a few minutes to pull all ~8000 UK stations.

Verify:

```bash
# Check containers are running
docker compose ps

# Check API health
curl https://api.fueltracker.uk/api/health

# Check logs for successful ingestion
docker compose logs -f api
```

You should see:
```
✅ Database connected
⏱ Scheduler started: polling every 30 minutes
🔄 Running initial data ingestion...
[FuelFinder] Token refreshed, expires in 3600s
[FuelFinder] /api/v1/pfs batch 1: 500 items
...
[Ingestion] Cycle complete
```

## 2. Deploy the Web App

```bash
cd ~/
git clone <fuel-web-repo-url> fuel-web
cd fuel-web
```

Build and start:

```bash
docker compose up -d --build
```

The `NEXT_PUBLIC_API_BASE_URL=https://api.fueltracker.uk` is baked into the client bundle at build time via a Docker build arg in `docker-compose.yml`.

Verify:

```bash
docker compose ps
curl -s https://fueltracker.uk | head -20
```

## Updating

### API update

```bash
cd ~/fuel-api
git pull
docker compose up -d --build
```

The database volume persists across rebuilds. `prisma db push` runs on each container start and applies any schema changes automatically.

### Web update

```bash
cd ~/fuel-web
git pull
docker compose up -d --build
```

If the API URL changes, update the `NEXT_PUBLIC_API_BASE_URL` build arg in `docker-compose.yml` and rebuild.

## Database

### Connect directly

Postgres is bound to the host's loopback interface on port 5433 for debugging (not reachable remotely — use an SSH tunnel if connecting from another machine):

```bash
psql -h localhost -p 5433 -U fuel fueldb
```

### Backup

```bash
docker exec fuel-db pg_dump -U fuel fueldb > backup-$(date +%Y%m%d).sql
```

### Restore

```bash
cat backup.sql | docker exec -i fuel-db psql -U fuel fueldb
```

### Reset (wipe all data)

```bash
cd ~/fuel-api
docker compose down -v   # removes the pgdata volume
docker compose up -d     # fresh DB, triggers re-ingestion
```

## Manual ingestion

Trigger a data refresh without waiting for the cron (requires the `ADMIN_API_KEY` set in `.env.production`):

```bash
curl -X POST -H "X-Admin-Key: $ADMIN_API_KEY" https://api.fueltracker.uk/api/admin/ingest
```

## Troubleshooting

### API crash-loops with `P1012` / "Environment variable not found: DATABASE_URL"

`docker logs fuel-api` shows a Prisma schema validation error and the container keeps restarting. This means `DATABASE_URL` isn't actually set — check `.env.production` has an explicit `DATABASE_URL=postgresql://fuel:<password>@fuel-db:5432/fueldb` line (see the `.env.production` example above); it is not set anywhere in `docker-compose.yml` and won't appear by itself. After fixing it: `docker compose up -d` (a restart is enough here, since only the env var changed, not the image).

If the error instead says the URL "must start with the protocol `file:`" (i.e. `DATABASE_URL` *is* found, but Prisma still thinks the datasource is SQLite), the image was built before the Dockerfile's `sed -i 's/provider = "sqlite"/provider = "postgresql"/'` swap took effect (or a prior version of the Dockerfile had it in the wrong order relative to `COPY . .`, silently reverting it). Force a full rebuild with `docker compose build --no-cache api && docker compose up -d` — a plain restart won't fix a stale image.

### API won't start — "database not ready"

The API container waits for the Postgres healthcheck. If the DB is slow to start:

```bash
docker compose logs db    # check for Postgres errors
docker compose restart api
```

### No stations after startup

Check the API logs for ingestion errors:

```bash
docker compose logs api | grep -i "ingestion\|error\|token"
```

Common causes:
- Invalid Fuel Finder credentials in `.env.production`
- Network issue reaching `www.fuel-finder.service.gov.uk` from the container

### Web app shows no data

- Verify the API is reachable: `curl https://api.fueltracker.uk/api/health`
- Check browser console for CORS or network errors
- Ensure `NEXT_PUBLIC_API_BASE_URL` in `docker-compose.yml` matches the actual API domain

### Rebuilding after schema changes

If `prisma/schema.prisma` changes:

```bash
cd ~/fuel-api
git pull
docker compose up -d --build
```

`prisma db push` runs on container start and applies additive schema changes (new columns, tables). For destructive changes (dropping columns), you may need to run migrations manually:

```bash
docker exec fuel-api npx prisma migrate dev --name describe-the-change
```

## Ports reference

| Service | Container port | Host port | Traefik domain |
|---|---|---|---|
| fuel-api | 8000 | 8200 | api.fueltracker.uk |
| fuel-web | 3000 | 8201 | fueltracker.uk / www.fueltracker.uk |
| fuel-db | 5432 | 5433 | (internal only) |
