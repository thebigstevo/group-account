#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
environment="${1:-}"

case "$environment" in
  dev)
    role="treasurio_dev"
    database="treasurio_dev"
    password="${DEV_DB_PASSWORD:-}"
    ;;
  prod)
    role="treasurio_prod"
    database="treasurio_prod"
    password="${PROD_DB_PASSWORD:-}"
    ;;
  *)
    echo "Usage: $0 <dev|prod>" >&2
    exit 2
    ;;
esac

[[ ${#password} -ge 24 ]] || { echo "Database password must be at least 24 characters" >&2; exit 2; }

for attempt in $(seq 1 30); do
  if docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres pg_isready -U treasurio >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" == 30 ]] && { echo "PostgreSQL did not become ready" >&2; exit 1; }
  sleep 2
done
# The official image briefly accepts connections through a temporary server
# during first-time initialization, then restarts PostgreSQL. Wait through that
# hand-off before applying grants.
sleep 5
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres pg_isready -U treasurio >/dev/null

docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  psql -U treasurio -d postgres -v ON_ERROR_STOP=1 \
  -v app_role="$role" -v app_database="$database" -v app_password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'app_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'app_role', :'app_password') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'app_database') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'app_database', :'app_role') \gexec
SQL

docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  psql -U treasurio -d "$database" -v ON_ERROR_STOP=1 -v app_role="$role" <<'SQL'
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE treasurio IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE treasurio IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'app_role') \gexec
SQL

# Explicitly prevent this role from connecting to the other environment.
other_database="treasurio_prod"
[[ "$environment" == "prod" ]] && other_database="treasurio_dev"
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  psql -U treasurio -d postgres -v ON_ERROR_STOP=1 -v app_role="$role" -v other_database="$other_database" <<'SQL'
SELECT format('REVOKE CONNECT ON DATABASE %I FROM %I', :'other_database', :'app_role') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'other_database') \gexec
SQL

echo "Provisioned least-privilege role $role for $database"
