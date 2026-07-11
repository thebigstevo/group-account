#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

PGDATABASE="${PGDATABASE:-treasurio}"
PGUSER="${PGUSER:-treasurio}"

# Check argument
if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup-file.sql.gz>"
  echo ""
  echo "Example:"
  echo "  $0 backups/treasurio_20240115_143000.sql.gz"
  exit 1
fi

BACKUP_FILE="$1"

# Resolve relative paths
if [[ "$BACKUP_FILE" != /* ]]; then
  BACKUP_FILE="$SCRIPT_DIR/$BACKUP_FILE"
fi

# Validate backup file
if [ ! -f "$BACKUP_FILE" ]; then
  echo "✗ Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

if [[ "$BACKUP_FILE" != *.sql.gz ]]; then
  echo "✗ Error: Expected a .sql.gz file"
  exit 1
fi

echo "============================================"
echo "  Treasurio — Database Restore"
echo "============================================"
echo ""
echo "Backup file: $BACKUP_FILE"
echo "Database:    $PGDATABASE"
echo "User:        $PGUSER"
echo ""
echo "WARNING: This will DROP and RECREATE the database."
echo "         All current data will be lost."
echo ""
read -rp "Are you sure you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled."
  exit 0
fi

echo ""
echo "Dropping and recreating database '${PGDATABASE}'..."

# Drop and recreate the database
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS \"${PGDATABASE}\";"

docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  psql -U "$PGUSER" -d postgres -c "CREATE DATABASE \"${PGDATABASE}\" OWNER \"${PGUSER}\";"

echo "✓ Database recreated"
echo ""
echo "Restoring from backup..."

# Restore from the gzipped dump
gunzip -c "$BACKUP_FILE" | docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  psql -U "$PGUSER" -d "$PGDATABASE" --quiet

if [ $? -eq 0 ]; then
  echo "✓ Database restored successfully from: $(basename "$BACKUP_FILE")"
else
  echo "✗ Restore failed"
  exit 1
fi

echo ""
echo "Done. You may want to restart the application:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml restart accounts"
