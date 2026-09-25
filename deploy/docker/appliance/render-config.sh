#!/bin/sh
# Render /app/web/config.js from the container environment. Same rules as the
# standalone web image's docker-entrypoint.sh: escape JS string literals, never
# trust raw env bytes.
#
# Appliance difference: an unset URL defaults to the *page's own origin* via
# window.location.origin. Everything in this container is reachable through
# the same nginx (API under /v1/, bridge under /bridge/), so the dashboard
# needs no absolute host: it works on localhost, a LAN IP, or a port remap
# without reconfiguration.
set -eu

CONFIG_OUT="${WARMBLY_CONFIG_OUT:-/app/web/config.js}"
mkdir -p "$(dirname "$CONFIG_OUT")"

js() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\r\n'
}

# "..." for a set value, bare window.location.origin for an empty one.
url_or_origin() {
    if [ -n "${1:-}" ]; then printf '"%s"' "$(js "$1")"; else printf 'window.location.origin'; fi
}

API_URL_LINE=$(url_or_origin "${WARMBLY_API_URL:-}")
APP_URL_LINE=$(url_or_origin "${WARMBLY_APP_URL:-}")

cat > "$CONFIG_OUT" <<EOF
window.__WARMBLY_ENV__ = {
  API_URL: $API_URL_LINE,
  APP_URL: $APP_URL_LINE,
  TURNSTILE_KEY: "$(js "${WARMBLY_TURNSTILE_KEY:-}")",
  BETA_NOTICE: "$(js "${WARMBLY_BETA_NOTICE:-}")",
  SENTRY_DSN: "$(js "${WARMBLY_SENTRY_DSN:-}")",
  SENTRY_ENVIRONMENT: "$(js "${WARMBLY_SENTRY_ENVIRONMENT:-}")",
  POSTHOG_KEY: "$(js "${WARMBLY_POSTHOG_KEY:-}")",
  POSTHOG_HOST: "$(js "${WARMBLY_POSTHOG_HOST:-}")",
  POSTHOG_UI_HOST: "$(js "${WARMBLY_POSTHOG_UI_HOST:-}")",
  POSTHOG_ERROR_TRACKING: "$(js "${WARMBLY_POSTHOG_ERROR_TRACKING:-}")",
  POSTHOG_SESSION_REPLAY: "$(js "${WARMBLY_POSTHOG_SESSION_REPLAY:-}")",
  LOCAL_OWNER_EMAIL: "$(js "${WARMBLY_LOCAL_OWNER_EMAIL:-}")",
  LOCAL_OWNER_PASSWORD: "$(js "${WARMBLY_LOCAL_OWNER_PASSWORD:-}")",
  BRIDGE_URL: "$(js "${WARMBLY_BRIDGE_URL:-}")"
};
EOF

chmod 644 "$CONFIG_OUT"
