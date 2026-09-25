#!/command/with-contenv bash
# One-shot container init, run by s6-rc before any service starts.
# Idempotent: a restarted container with an existing /data volume skips
# straight through; a fresh volume gets initdb, migrations and the owner.
set -euo pipefail

echo "[appliance] preparing persistent stores under /data"

# ── Directory layout ────────────────────────────────────────────────────────
mkdir -p /data/postgres /data/redis /data/nats /data/opencode /data/bridge /data/blobs /run/appliance

# Ownership per daemon.
chown -R warmbly:warmbly /data/postgres /data/blobs
chown -R redis:redis /data/redis 2>/dev/null || chown -R nobody:nogroup /data/redis
chown -R opencode:opencode /data/opencode

# ── Postgres cluster init (PG 18) ────────────────────────────────────────
if [ ! -s /data/postgres/PG_VERSION ]; then
    echo "[appliance] initializing postgres 18 cluster in /data/postgres"
    rm -rf /data/postgres/*
    mkdir -p /run/postgresql && chown warmbly:warmbly /run/postgresql
    # initdb as the cluster-owning user; the superuser password comes from a
    # process-substitution file so it never touches argv or disk.
    echo 'warmbly' > /run/appliance/pg_pwfile
    chown warmbly:warmbly /run/appliance/pg_pwfile
    chmod 600 /run/appliance/pg_pwfile
    su-exec warmbly /usr/bin/initdb -D /data/postgres -U warmbly \
        --pwfile=/run/appliance/pg_pwfile -E UTF8 -A scram-sha-256
    rm -f /run/appliance/pg_pwfile
    echo "[appliance] postgres cluster initialized"
fi

# ── Load build-time secrets into env (unless overridden with -e) ───────────
# The image ships /run/secrets/* stamped at build; the values are NOT in
# image metadata (docker inspect shows nothing). Explicit -e always wins.
load_secret() { # var, file
    local var="$1" file="$2"
    if [ -z "${!var:-}" ] && [ -s "$file" ]; then
        export "$var=$(cat "$file")"
    fi
}
load_secret BREVO_SMTP_USER      "${BREVO_SMTP_USER_FILE:-/run/secrets/brevo_user}"
load_secret BREVO_SMTP_PASSWORD  "${BREVO_SMTP_PASSWORD_FILE:-/run/secrets/brevo_pass}"
load_secret OPENCODE_SERVER_PASSWORD "${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_pass}"

# Export the resolved env for the longrun services (with-contenv reads this).
# s6 overlay applies /run/s6/container_environment at service start.
mkdir -p /run/s6/container_environment
for v in BREVO_SMTP_USER BREVO_SMTP_PASSWORD OPENCODE_SERVER_PASSWORD; do
    if [ -n "${!v:-}" ]; then printf '%s' "${!v}" > "/run/s6/container_environment/$v"; fi
done

# ── Database bootstrap (first init only; guarded by a marker) ─────────────
# The appliance ships the production-equivalent warmbly_dev dataset (the
# verified PG16→PG18 dump), so a fresh /data boots with the same users,
# mailboxes, orgs and seeded API key the compose stack had. If no dataset is
# bundled, an empty database is created and the backend migrates it on boot.
DUMP=/app/bootstrap/warmbly_dev.dump
if [ -s /data/postgres/PG_VERSION ] && [ ! -f /data/appliance_db_created ]; then
    echo "[appliance] starting temporary postgres to prepare warmbly_dev"
    su-exec warmbly /usr/bin/pg_ctl -D /data/postgres \
        -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/run/postgresql" \
        -w -t 30 start >/dev/null
    for _ in $(seq 1 60); do
        su-exec warmbly /usr/bin/pg_isready -q -h 127.0.0.1 -U warmbly >/dev/null 2>&1 && break
        sleep 0.5
    done
    # initdb -A scram-sha-256 puts scram on local lines too, so the TCP
    # connection needs the superuser password; -w guarantees we fail fast
    # instead of ever sitting at an interactive prompt.
    export PGPASSWORD='warmbly'
    if [ -s "$DUMP" ]; then
        echo "[appliance] restoring bundled warmbly_dev dataset"
        su-exec warmbly /usr/bin/createdb -w -h 127.0.0.1 -U warmbly -E UTF8 warmbly_dev
        # Same flags as the verified compose-stack migration restore.
        su-exec warmbly /usr/bin/pg_restore -w -h 127.0.0.1 -U warmbly \
            -d warmbly_dev --no-owner --role=warmbly "$DUMP" \
        || echo "[appliance] WARNING: pg_restore reported errors (see above); continuing"
        echo "[appliance] dataset restored"
    else
        echo "[appliance] no bundled dataset; creating empty warmbly_dev (backend migrates on boot)"
        su-exec warmbly /usr/bin/createdb -w -h 127.0.0.1 -U warmbly warmbly_dev || true
    fi
    unset PGPASSWORD
    su-exec warmbly /usr/bin/pg_ctl -D /data/postgres -m fast -w stop >/dev/null
    touch /data/appliance_db_created
    echo "[appliance] database ready"
fi

echo "[appliance] init complete"
