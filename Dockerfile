FROM node:22-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# --- Build stage ---
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Switch Prisma provider to PostgreSQL for production. Must run after `COPY . .`, not before —
# an earlier COPY . . here would silently overwrite this sed'd schema.prisma with the original
# sqlite version from the build context, since prisma/ isn't excluded from that copy.
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
RUN grep -q 'provider = "postgresql"' prisma/schema.prisma || (echo "sed failed to switch Prisma provider to postgresql" >&2 && exit 1)
RUN npx prisma generate
RUN npm run build

# --- Production stage ---
FROM base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist

EXPOSE 8000

CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
