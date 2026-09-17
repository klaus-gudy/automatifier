#!/usr/bin/env bash
#
# One-shot production setup: gives automatifier on Railway the same database
# arrangement it has locally.
#
#   1. creates the `automatifier` role (SELECT-only on jarvis's `public`
#      tables) and the `automatifier` schema it owns, with a random password
#      that is never printed;
#   2. points automatifier's DATABASE_URL at that role;
#   3. redeploys once with DATABASE_MIGRATIONS_RUN=true so the
#      `lease_reminder` table is created;
#   4. waits for the table, then turns DATABASE_MIGRATIONS_RUN back off.
#
# Usage:
#   scripts/railway-setup-db-role.sh           # do it
#   scripts/railway-setup-db-role.sh --check   # only report current state
set -euo pipefail

PROJECT=4fcd33ac-0d14-4214-9056-739c80443c59
ENV=production

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

# psql against Railway Postgres as the postgres superuser. Credentials come
# from Railway at run time and are never echoed.
pg() {
  railway run -p "$PROJECT" -e "$ENV" -s Postgres -- \
    sh -c 'psql "$DATABASE_PUBLIC_URL" -X -v ON_ERROR_STOP=1 "$@"' sh "$@"
}

state() {
  pg -At -F ' ' -c "
    SELECT
      (SELECT count(*) FROM pg_roles WHERE rolname = 'automatifier'),
      (SELECT count(*) FROM pg_namespace WHERE nspname = 'automatifier'),
      (to_regclass('automatifier.lease_reminder') IS NOT NULL)::int"
}

command -v railway >/dev/null || die "Railway CLI not installed"
command -v psql >/dev/null    || die "psql not installed"
command -v openssl >/dev/null || die "openssl not installed"

say "Checking Railway production database"
read -r ROLE SCHEMA TABLE <<<"$(state)"
echo "role automatifier exists:        $([ "$ROLE" = 1 ] && echo yes || echo no)"
echo "schema automatifier exists:      $([ "$SCHEMA" = 1 ] && echo yes || echo no)"
echo "table lease_reminder exists:     $([ "$TABLE" = 1 ] && echo yes || echo no)"

if [ "${1:-}" = "--check" ]; then exit 0; fi

if [ "$TABLE" = 1 ]; then
  say "Already set up — nothing to do."
  exit 0
fi
if [ "$ROLE" = 1 ]; then
  die "role 'automatifier' already exists but setup is incomplete. Ask Claude to finish it rather than re-running this."
fi

say "Step 1/4: creating role + schema (password is random and not shown)"
PW=$(openssl rand -hex 24)
pg -v pw="$PW" <<'SQL'
BEGIN;
CREATE ROLE automatifier LOGIN PASSWORD :'pw';
GRANT CONNECT ON DATABASE railway TO automatifier;
GRANT USAGE ON SCHEMA public TO automatifier;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO automatifier;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO automatifier;
CREATE SCHEMA automatifier AUTHORIZATION automatifier;
COMMIT;
SQL

CHECK=$(pg -At -F ' ' -c "
  SELECT has_table_privilege('automatifier', 'public.\"Lease\"', 'SELECT')::int,
         has_table_privilege('automatifier', 'public.\"Lease\"', 'UPDATE')::int,
         has_schema_privilege('automatifier', 'automatifier', 'CREATE')::int")
[ "$CHECK" = "1 0 1" ] || die "grants look wrong (got '$CHECK', expected '1 0 1')"
echo "OK: can read Lease, cannot write it, owns its schema"

say "Step 2/4: turning on migrations for the next deploy"
railway variable set DATABASE_MIGRATIONS_RUN=true \
  -p "$PROJECT" -e "$ENV" -s automatifier --skip-deploys >/dev/null
echo "OK"

say "Step 3/4: pointing DATABASE_URL at the new role (this redeploys automatifier)"
printf 'postgresql://automatifier:%s@postgres.railway.internal:5432/railway' "$PW" |
  railway variable set DATABASE_URL --stdin \
    -p "$PROJECT" -e "$ENV" -s automatifier >/dev/null
unset PW
echo "OK — deploy started"

say "Step 4/4: waiting for the deploy to create lease_reminder (up to 10 min)"
for i in $(seq 1 60); do
  read -r _ _ TABLE <<<"$(state)"
  if [ "$TABLE" = 1 ]; then
    echo "OK: automatifier.lease_reminder created"
    railway variable set DATABASE_MIGRATIONS_RUN=false \
      -p "$PROJECT" -e "$ENV" -s automatifier --skip-deploys >/dev/null
    echo "OK: DATABASE_MIGRATIONS_RUN back to false"
    say "All done. Tell Claude so it can verify the logs."
    exit 0
  fi
  printf '.'
  sleep 10
done

die "table did not appear within 10 minutes. The role and DATABASE_URL are in place; tell Claude so it can read the deploy logs."
