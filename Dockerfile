FROM node:22-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# --- Build stage ---
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
# Switch Prisma provider to PostgreSQL for production
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
RUN npx prisma generate
COPY . .
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
