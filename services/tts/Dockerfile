# ── build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies first (layer-cached unless lockfile changes).
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Only production deps in the final image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist

# Port for the future HTTP wrapper (src/server.ts).
# Until server.ts is added the container is a library image only and will
# not bind to this port — see README.md roadmap.
EXPOSE 3010

ENV NODE_ENV=production
ENV TTS_MAX_RETRIES=3
ENV TTS_MAX_DELAY_MS=60000

# Placeholder: replace with `node dist/server.js` once the HTTP wrapper is added.
CMD ["node", "-e", "console.log('TTS service library image. Add src/server.ts and rebuild to run as a server. See services/tts/README.md.')"]
