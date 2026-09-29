# syntax=docker/dockerfile:1

# Debian rather than Alpine on purpose: better-sqlite3 and serialport both
# ship glibc prebuilds, and on musl they would have to be compiled from
# source in every image build.
ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------------------
# Dependencies, with the two native modules built for this image's arch.
#
# `--ignore-scripts` is not optional here: @meshtastic/core and
# @meshtastic/transport-node-serial both declare `preinstall: npx only-allow
# pnpm`, which aborts any npm install that runs lifecycle scripts. We skip
# every script, then rebuild by name the three packages that genuinely need
# one. Newer npm can express this as `allowScripts` in package.json, but
# doing it here keeps the build working on whatever npm the base image ships.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
    && npm rebuild better-sqlite3 @serialport/bindings-cpp esbuild

# ---------------------------------------------------------------------------
# Compile the server and bundle the web UI.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime dependencies only -- no TypeScript, no Vite.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 @serialport/bindings-cpp \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Final image.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    MFM_CONFIG=/config/config.yaml

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Both mount points exist and are owned by the runtime user, so a bind mount
# of an empty host directory does not land as root-owned and unwritable.
# The database directory must be writable, not just the file: WAL mode
# creates -wal and -shm siblings beside it.
RUN mkdir -p /config /data && chown -R node:node /config /data

USER node

# Documentation only -- it publishes nothing, and the real port comes from
# server.port in the mounted config. Matches the default in that config.
EXPOSE 8432

# Reading the status endpoint proves the HTTP server and the SQLite handle
# are both alive. It deliberately does not assert the radio is connected --
# an unplugged radio is a condition to display, not a reason to kill the
# container and lose the history it has already collected. 401 counts as
# healthy: the auth gate answering is exactly the proof we want.
#
# The port is read from the same config the server reads rather than
# hardcoded. Hardcoding it means that changing server.port silently marks
# the container permanently unhealthy, which then blocks anything with a
# `depends_on: service_healthy` on it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const {parse}=require('yaml');const {readFileSync}=require('fs');let p=8432;try{p=parse(readFileSync(process.env.MFM_CONFIG,'utf8'))?.server?.port??p}catch{};fetch('http://127.0.0.1:'+p+'/api/status').then(r=>process.exit(r.status===401||r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server/index.js"]
