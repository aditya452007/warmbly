# syntax=docker/dockerfile:1.7
#
# ============================================================================
# Warmbly ONE-CONTAINER appliance: the whole local platform in a single
# container, runnable straight from the Docker Desktop UI.
# ============================================================================
#
#   docker run -d --name warmbly -p 5173:5173 -p 8080:8080 -p 8787:8787 \
#     -v warmbly_data:/data warmbly-appliance:latest
#
# ...or just set the image's env in the Docker Desktop "Run" dialog — every
# credential below has a default baked at build time from the local .env, so a
# plain `docker run` works with zero configuration.
#
# What runs inside (supervised by s6-overlay, logs all on the container's
# stdout so `docker logs warmbly` shows everything):
#
#   postgres :5432   PG 18, data under /data/postgres (persistent volume)
#   redis            cache + realtime fanout, persistence under /data/redis
#   nats     :4222   JetStream event bus, stream data under /data/nats
#   backend  :8080   Go API; applies migrations on boot; creates the owner
#   worker           send/sync executor (in-process here)
#   consumer         event consumer (in-process here)
#   tracking :3000   Rust open/click pixels
#   opencode :4096   headless AI agent server the bridge drives
#   bridge   :8787   AI orchestration (drafts, sends via Brevo)
#   web      :80     nginx serving the built dashboard
#
# Published ports from the host: 5173 → web (via the run command above), and
# optionally 8080 (API) and 8787 (bridge, browser-direct). Everything else is
# internal. One named volume holds every store, so the container is stateless
# and upgradable: stop, `docker pull` the new image, start, data intact.
#
# Build (from the repo root):
#   docker build -f deploy/docker/appliance.Dockerfile -t warmbly-appliance:latest .
#
# s6 RATIONALE: one container, many daemons, each supervised with automatic
# restart and dependency ordering (s6-rc). PID 1 is s6, so zombies are reaped
# and any crashed service comes back without taking the container down.

# ── Stage 1: Go binaries ───────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS go-builder
ARG TARGETOS TARGETARCH
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,id=appliance-gomod,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,id=appliance-gomod,target=/go/pkg/mod \
    --mount=type=cache,id=appliance-gobuild,target=/root/.cache/go-build \
    set -eux; \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o /out/backend  ./cmd/backend; \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o /out/consumer ./cmd/consumer; \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o /out/worker   ./cmd/worker; \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -o /out/migrate  ./cmd/migrate

# ── Stage 2: dashboard bundle ──────────────────────────────────────────────
FROM node:24-alpine AS web-builder
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
# The auto-login credentials and URLs are baked in; config.js (rendered at
# container start) can still override every one of them at run time.
ARG VITE_LOCAL_OWNER_EMAIL
ARG VITE_LOCAL_OWNER_PASSWORD
RUN pnpm build

# ── Stage 3: bridge bundle ─────────────────────────────────────────────────
FROM node:24-alpine AS bridge-builder
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY bridge/package.json bridge/pnpm-lock.yaml bridge/pnpm-workspace.yaml ./
# Native toolchain for better-sqlite3 (no prebuilt musl binding).
RUN apk add --no-cache python3 make g++ \
    && pnpm install --frozen-lockfile
COPY bridge/ ./
RUN pnpm build

# ── Stage 4: bridge runtime node_modules (production, sqlite binding) ─────
FROM node:24-alpine AS bridge-runtime
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
RUN apk add --no-cache python3 make g++
COPY bridge/package.json bridge/pnpm-lock.yaml bridge/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
# The binding compiled here matches this base image's musl/node ABI, and this
# stage's node_modules ships verbatim into the final image.
RUN node -e "require('better-sqlite3'); console.log('sqlite ok')"

# ── Stage 5: tracking (Rust) ───────────────────────────────────────────────
FROM rust:1-alpine AS tracking-builder
RUN apk add --no-cache musl-dev pkgconfig openssl-dev
WORKDIR /build
COPY tracking/ ./
ENV CARGO_NET_RETRY=10
RUN --mount=type=cache,id=appliance-cargo,target=/usr/local/cargo/registry \
    CARGO_TARGET_DIR=/build/target cargo build --release && cp /build/target/release/tracking /out-tracking

# ── Stage 6: appliance runtime ─────────────────────────────────────────────
FROM alpine:3.23

# ── Core packages. Versions are resolved at build time from alpine 3.23 —
#    the same rolling-latest policy as the rest of this stack. nodejs powers
#    the bridge runtime; postgresql18-client gives pg_isready for readiness
#    gates; unzip installs the OpenCode release archive.
RUN apk add --no-cache \
    postgresql18 postgresql18-client \
    redis \
    nats-server \
    nginx \
    nodejs \
    ca-certificates tzdata curl bash unzip git \
    su-exec

# s6-overlay: pin to a current v3 release. Bumped deliberately, not floating.
ARG S6_OVERLAY_VERSION=3.2.1.0
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
        amd64) S6_ARCH=x86_64 ;; \
        arm64) S6_ARCH=aarch64 ;; \
        *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/s6.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    && curl -fsSL -o /tmp/s6-arch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
    && tar -C / -Jxpf /tmp/s6.tar.xz \
    && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
    && rm /tmp/s6.tar.xz /tmp/s6-arch.tar.xz

# ── App binaries and bundles ───────────────────────────────────────────────
COPY --from=go-builder /out/backend   /app/backend
COPY --from=go-builder /out/consumer  /app/consumer
COPY --from=go-builder /out/worker    /app/worker
COPY --from=go-builder /out/migrate   /app/migrate
COPY --from=web-builder    /app/dist            /app/web
COPY --from=bridge-builder /app/dist            /app/bridge/dist
COPY --from=bridge-runtime /app/node_modules    /app/bridge/node_modules
COPY bridge/package.json /app/bridge/package.json
COPY --from=tracking-builder /out-tracking /app/tracking

# ── Bundled warmbly_dev dataset (same data/config as the compose stack) ────
# Restored into a fresh /data on first boot (see boot.sh): same users,
# mailboxes, orgs and seeded API key, so the dashboard and bridge see exactly
# what the compose stack saw before the appliance.
COPY .run/pg18-migration/warmbly_dev_pg16.dump /app/bootstrap/warmbly_dev.dump

# ── OpenCode (official install script, pinned version) ─────────────────────
# Same proven path as deploy/docker/opencode.Dockerfile: the standalone
# self-contained Bun binary lands in $HOME/.opencode/bin and is normalized
# onto PATH for every user (the opencode service runs as the `opencode` user).
ARG OPENCODE_VERSION=1.18.26
RUN set -eux; \
    curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && opencode --version

# ── Users ──────────────────────────────────────────────────────────────────
# adduser needs the home directory to pre-exist, so /data/opencode is created
# here (the layout step below only extends it).
RUN mkdir -p /data/opencode \
    && addgroup -S warmbly \
    && adduser -S -G warmbly -h /var/lib/postgresql -D warmbly \
    && addgroup -S opencode \
    && adduser -S -G opencode -h /data/opencode -D opencode

# ── Layout: every persistent store lives under /data (the volume) ──────────
RUN mkdir -p /data/postgres /data/redis /data/nats /data/opencode /data/bridge /data/blobs /data/logs \
    && chown -R warmbly:warmbly /data/postgres /data/blobs \
    && chown -R redis /data/redis 2>/dev/null; chown -R opencode:opencode /data/opencode; \
    chown -R warmbly:warmbly /app/web; \
    true

# ── nginx: serve the dashboard with an API/bridge reverse proxy ────────────
COPY deploy/docker/appliance/nginx.conf /etc/nginx/http.d/default.conf

# ── s6 service definitions ─────────────────────────────────────────────────
COPY deploy/docker/appliance/s6-rc/ /etc/s6-overlay/s6-rc.d/
# Longrun bundle: one empty marker file per service the user bundle starts.
# (Generated here rather than committed, so the source tree carries no
# build-generated trivia.)
RUN for svc in postgres redis nats backend consumer worker tracking opencode bridge web; do \
        touch "/etc/s6-overlay/s6-rc.d/user/contents.d/$svc"; \
    done

# ── One-time boot init (cluster, database, secrets) ──────────────────────
COPY deploy/docker/appliance/boot.sh /etc/s6-overlay/scripts/boot.sh
COPY deploy/docker/appliance/render-config.sh /etc/appliance/render-config.sh
RUN chmod +x /etc/s6-overlay/scripts/boot.sh /etc/appliance/render-config.sh

# ── Environment: baked defaults from the local .env, all overridable ───────
# A plain `docker run` (no -e) still gets a fully working, fully configured
# stack; the Docker Desktop run dialog can change any of them per launch.
ENV APP_ENV=dev \
    DEPLOYMENT_MODE=self_hosted \
    # Addresses inside the container; nginx front-ports the dashboard.
    APP_URL=http://localhost:5173 \
    API_PUBLIC_URL=http://localhost:8080 \
    # "*" on purpose: the appliance serves the dashboard and the API from the
    # same nginx origin (see nginx.conf), so cross-origin calls never happen;
    # auth is bearer-token (no cookies), and the container must answer on
    # whatever host/port the user maps without re-baking an allowlist.
    CORS_ALLOW_ORIGINS=* \
    # Passkeys can only run on a secure context, which locally means localhost.
    # Pinned so the "*" above does not feed a literal "*" into the RP config.
    WEBAUTHN_RP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
    WEBSOCKET_URL=ws://localhost:4000/socket/websocket \
    TRACKING_DOMAIN=localhost:3000 \
    # Secrets. Local-only defaults; override on the host for anything shared.
    AUTH_SECRET=shodasha-local-auth-secret-0123456789abcdef \
    INTERNAL_API_TOKEN=shodasha-local-internal-token-0123456789abcdef \
    SECRET_KEY_BASE=shodasha-local-phoenix-secret-key-base-0123456789abcdef0123456789abcdef \
    KMS_LOCAL_MASTER_KEY=Xr0JA7gqF2POy29a7MRByyqddivTNt8WOyKsOXklazk= \
    CREDENTIALS_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    # Owner auto-provisioning (first boot, while users table is empty).
    WARMBLY_BOOTSTRAP_EMAIL=adityathakur452007@gmail.com \
    WARMBLY_BOOTSTRAP_PASSWORD=Shodasha@2026 \
    WARMBLY_BOOTSTRAP_ORG=Shodasha \
    # Dashboard auto-login.
    WARMBLY_LOCAL_OWNER_EMAIL=adityathakur452007@gmail.com \
    WARMBLY_LOCAL_OWNER_PASSWORD=Shodasha@2026 \
    # Auth policy: zero-friction local single-operator.
    DISABLE_REGISTRATION=true \
    AUTH_LOGIN_CODE=off \
    REQUIRE_EMAIL_VERIFICATION=false \
    CAPTCHA_PROVIDER=none \
    # Datastores (all in-container).
    PRIMARY_DB=postgres://warmbly:warmbly@127.0.0.1:5432/warmbly_dev?sslmode=disable \
    REDIS=redis://127.0.0.1:6379 \
    NATS_URL=nats://127.0.0.1:4222 \
    EVENTBUS_PROVIDER=nats \
    CODEC_PROVIDER=json \
    KMS_PROVIDER=local \
    BLOB_PROVIDER=filesystem \
    BLOB_FS_ROOT=/data/blobs \
    TASKS_PROVIDER=local \
    PUBSUB_ENABLED=false \
    BILLING_PROVIDER=none \
    AWS_CONFIG_ENABLED=false \
    # The worker reaches the DEK store over the backend's internal API (the
    # postgres provider needs a *db.DB, which only the backend itself has).
    ENCRYPTED_KEYS_PROVIDER=http \
    ENCRYPTED_KEYS_BACKEND_URL=http://127.0.0.1:8080 \
    ENCRYPTED_KEYS_WORKER_TOKEN=shodasha-local-internal-token-0123456789abcdef \
    WORKER_STATE_DIR=/data/worker-state \
    MAIL_TRANSPORT=log \
    EMAIL_NAME=Shodasha \
    EMAIL_ADDRESS=adityathakur452007@gmail.com \
    GEODB_PATH=/data/GeoLite2-City.mmdb \
    # API server.
    API_HOST=0.0.0.0:8080 \
    GIN_MODE=release \
    # Bridge.
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8787 \
    BRIDGE_DB_PATH=/data/bridge/bridge.sqlite \
    BRIDGE_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174 \
    WARMBLY_API_BASE_URL=http://127.0.0.1:8080 \
    WARMBLY_API_KEY=wmbly_seed_acme_owner_full_access_0000000000 \
    AI_PROVIDER=opencode \
    OPENCODE_BASE_URL=http://127.0.0.1:4096 \
    OPENCODE_SERVER_USERNAME=opencode \
    OPENCODE_MODEL=opencode/muse-spark-1.3-contributor-free \
    EMAIL_PROVIDER=brevo \
    BREVO_SMTP_HOST=smtp-relay.brevo.com \
    BREVO_SMTP_PORT=587 \
    SMTP_SECURITY=starttls \
    SEND_MODE=live \
    # Brevo credentials are injected at build time (local .env); override at
    # run time with -e BREVO_SMTP_USER / -e BREVO_SMTP_PASSWORD.
    # OpenCode auth (injected at build time, overridable at run time).
    OPENCODE_SERVER_PASSWORD= \
    # The dashboard reaches the bridge through the same-origin nginx /bridge/
    # proxy (see nginx.conf), so no second origin and no CORS is involved.
    WARMBLY_BRIDGE_URL=/bridge

# Build-time injection of the local-only credentials that have no safe empty
# default. They land as the files /run/secrets/* at build and are NOT kept in
# image metadata (unlike ENV); the entrypoint copies them to env at boot if
# the corresponding -e override was not provided.
ARG BREVO_SMTP_USER
ARG BREVO_SMTP_PASSWORD
ARG OPENCODE_SERVER_PASSWORD_ARG
RUN mkdir -p /run/secrets \
    && printf '%s' "$BREVO_SMTP_USER" > /run/secrets/brevo_user \
    && printf '%s' "$BREVO_SMTP_PASSWORD" > /run/secrets/brevo_pass \
    && printf '%s' "$OPENCODE_SERVER_PASSWORD_ARG" > /run/secrets/opencode_pass \
    && chmod 600 /run/secrets/*

ENV OPENCODE_SERVER_PASSWORD_FILE=/run/secrets/opencode_pass \
    BREVO_SMTP_USER_FILE=/run/secrets/brevo_user \
    BREVO_SMTP_PASSWORD_FILE=/run/secrets/brevo_pass

# ── Entrypoint ─────────────────────────────────────────────────────────────
ENTRYPOINT ["/init"]

# ── Healthcheck: the backend API, which is only healthy when Postgres has
#    been migrated and the API is answering. One probe covers the stack.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=10 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

EXPOSE 80 8080 8787 3000 4096 5432

VOLUME ["/data"]
