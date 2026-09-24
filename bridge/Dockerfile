# syntax=docker/dockerfile:1
#
# Local AI orchestration bridge. Build context is ./bridge (own package.json,
# own lockfile — there is no root workspace). better-sqlite3 has no prebuilt
# musl (alpine) binary, so the build stage carries the native toolchain to
# compile its binding; the runtime stage stays toolchain-free. The compiled
# binding travels with node_modules and matches the runtime's musl libc.

# ── Stage 1: build ────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
# No TTY in a build: CI=true makes pnpm reinstall instead of prompting.
ENV CI=true
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

# Dependencies first, so source edits do not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

# ── Stage 2: runtime ──────────────────────────────────────────────────────
# Only the compiled output plus the two runtime dependencies (better-sqlite3's
# native binding and nodemailer) are installed, kept out of the build tooling.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S bridge && adduser -S -G bridge bridge \
    && mkdir -p /data && chown -R bridge:bridge /data

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The SQLite database lives on the compose volume mounted at /data
# (BRIDGE_DB_PATH=/data/bridge.sqlite), owned by the runtime user above.
USER bridge
EXPOSE 8787

CMD ["node", "dist/index.js"]
