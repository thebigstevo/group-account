#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$SCRIPT_DIR")}"
export COMPOSE_PROJECT_NAME

usage() {
  echo "Usage: $0 database <dev|prod> <backup.sql.gz|s3://bucket/key>"
  echo "       $0 uploads <dev|prod> <backup.tar.gz|s3://bucket/key>"
}

[[ $# -eq 3 ]] || { usage; exit 2; }
kind="$1"
environment="$2"
backup_file="$3"

[[ "$environment" == "dev" || "$environment" == "prod" ]] || { usage; exit 2; }
downloaded_backup=""
if [[ "$backup_file" == s3://* ]]; then
  downloaded_backup="$(mktemp "${TMPDIR:-/tmp}/treasurio-restore.XXXXXX")"
  trap 'rm -f "$downloaded_backup"' EXIT
  aws s3 cp "$backup_file" "$downloaded_backup" --only-show-errors
  backup_file="$downloaded_backup"
fi
[[ -f "$backup_file" ]] || { echo "Backup not found: $backup_file" >&2; exit 2; }
gzip -t "$backup_file"

if [[ "$kind" == "database" ]]; then
  database="treasurio_${environment}"
  echo "Restoring $database from $backup_file"
  echo "This drops and recreates the selected database. Type the database name to continue:"
  read -r confirmation
  [[ "$confirmation" == "$database" ]] || { echo "Restore cancelled."; exit 1; }
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" stop "app-${environment}" || true
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
    psql -U treasurio -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();"
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
    psql -U treasurio -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"${database}\";"
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
    psql -U treasurio -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${database}\" OWNER treasurio;"
  gzip -dc "$backup_file" | docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
    psql -U treasurio -d "$database" -v ON_ERROR_STOP=1
  if [[ "$environment" == "dev" ]]; then
    DEV_DB_PASSWORD="${DEV_DB_PASSWORD:-}" "$SCRIPT_DIR/provision-app-role.sh" dev
  else
    PROD_DB_PASSWORD="${PROD_DB_PASSWORD:-}" "$SCRIPT_DIR/provision-app-role.sh" prod
  fi
elif [[ "$kind" == "uploads" ]]; then
  volume="${COMPOSE_PROJECT_NAME}_uploads-${environment}"
  echo "Restoring $volume from $backup_file"
  echo "This replaces every file in the selected upload volume. Type the volume name to continue:"
  read -r confirmation
  [[ "$confirmation" == "$volume" ]] || { echo "Restore cancelled."; exit 1; }
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" stop "app-${environment}" || true
  docker volume create "$volume" >/dev/null
  docker run --rm -i -v "${volume}:/data" postgres:16-alpine sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /data -xzf -' < "$backup_file"
else
  usage
  exit 2
fi

echo "Restore completed. Start app-${environment} after validating the restored data."
