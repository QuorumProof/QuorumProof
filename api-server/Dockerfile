# ── build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies first (layer-cached unless lockfile changes).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Only production deps in the final image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist

# #586 — Create the log directory so pino can open the file on first write.
# The directory is also bind-mounted by docker-compose so the host path
# /var/log/quorumproof is accessible to promtail for log shipping to Loki.
RUN mkdir -p /var/log/quorumproof

EXPOSE 3001

ENV NODE_ENV=production
ENV LOG_FILE=/var/log/quorumproof/api.log
ENV LOG_LEVEL=info
# Must match EXPOSE/ports/healthcheck above — src/index.ts defaults PORT to
# 3000 when unset, which left the container listening on a port nothing
# (including docker-compose's own healthcheck and Prometheus) could reach.
ENV PORT=3001

CMD ["node", "dist/index.js"]
