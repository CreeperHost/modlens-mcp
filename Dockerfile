# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# openssl lets Prisma correctly detect the engine for this platform
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma/ ./prisma/
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
# scripts/ holds build-template-db.mjs, invoked by `npm run build`.
COPY scripts/ ./scripts/

# `npm run build` generates the SQLite client, compiles with tsc, and builds the
# prebuilt template.db. (postinstall already generated the default Postgres/PGlite
# client into node_modules during `npm ci`.)
RUN npm run build

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-slim

# Java 21 (Temurin): required by Vineflower decompiler + bytecode indexer.
# Debian's default-jre is only 17; the tools need 21+ (see README prerequisites).
# openssl: required by the Prisma query engine at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget gnupg ca-certificates openssl \
    && mkdir -p /etc/apt/keyrings \
    && wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public \
        | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo $VERSION_CODENAME) main" \
        > /etc/apt/sources.list.d/adoptium.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends temurin-21-jre \
    && apt-get purge -y wget gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules/ ./node_modules/
# dist/ already contains the compiled SQLite client (tsc emits
# src/generated/sqlite → dist/generated/sqlite) plus the rest of the build.
COPY --from=builder /app/dist/ ./dist/
COPY package.json ./
# From the builder so the prebuilt template.db (made by `npm run build`) is
# included — the launcher copies it to /data on first run for zero-config SQLite.
COPY --from=builder /app/prisma/ ./prisma/
COPY scripts/ ./scripts/
# Vendored bytecode indexer. ensureIndexer() resolves this bundled copy
# (tools/mcsrc-indexer.jar next to the package) before any network fetch,
# so the container never downloads it from the GitHub release at runtime.
COPY tools/mcsrc-indexer.jar ./tools/mcsrc-indexer.jar

# Persistent data (DB, .env, tool cache) lives at /data
ENV MODLENS_HOME=/data
# Keep the decompile/tool cache on the same persistent, writable volume. Without
# this it defaults to ~/.modlens-cache, which is ephemeral and — when the
# container runs as a non-root uid (HOME unset → "/") — unwritable, making
# Vineflower fail with "Failed to save directory".
ENV MODLENS_CACHE_ROOT=/data/.modlens-cache
VOLUME ["/data"]

# When MCP_PORT is set the server starts the Streamable HTTP transport on this
# port (default path /mcp, liveness probe at /healthz). Left unset → stdio mode.
ENV MCP_PORT=3000
EXPOSE 3000

# Launcher (not server.js directly) so the container gets zero-config SQLite by
# default: on first run it bootstraps an embedded DB under /data. Provide
# DATABASE_URL (e.g. Postgres) to skip that and use your own database.
CMD ["node", "dist/launcher.js"]
