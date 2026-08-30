#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backups"
RETAIN_COUNT="${RETAIN_COUNT:-7}"

# Load environment
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

PGDATABASE="${PGDATABASE:-treasurio}"
PGUSER="${PGUSER:-treasurio}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate timestamped filename
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/treasurio_${TIMESTAMP}.sql.gz"

echo "Backing up database '${PGDATABASE}'..."

# Run pg_dump inside the postgres container
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U "$PGUSER" -d "$PGDATABASE" --clean --if-exists | gzip > "$BACKUP_FILE"

if [ $? -eq 0 ] && [ -s "$BACKUP_FILE" ]; then
  echo "✓ Backup saved: $BACKUP_FILE"
  echo "  Size: $(du -h "$BACKUP_FILE" | cut -f1)"
else
  echo "✗ Backup failed"
  rm -f "$BACKUP_FILE"
  exit 1
fi

# Retain only the last N backups
BACKUP_COUNT="$(find "$BACKUP_DIR" -name "treasurio_*.sql.gz" -type f | wc -l | tr -d ' ')"
if [ "$BACKUP_COUNT" -gt "$RETAIN_COUNT" ]; then
  REMOVE_COUNT=$((BACKUP_COUNT - RETAIN_COUNT))
  echo "Removing $REMOVE_COUNT old backup(s) (retaining last $RETAIN_COUNT)..."
  find "$BACKUP_DIR" -name "treasurio_*.sql.gz" -type f -printf '%T@ %p\n' 2>/dev/null | \
    sort -n | head -n "$REMOVE_COUNT" | cut -d' ' -f2- | \
    xargs rm -f 2>/dev/null || \
  # Fallback for macOS (no -printf)
  ls -t "$BACKUP_DIR"/treasurio_*.sql.gz 2>/dev/null | tail -n +"$((RETAIN_COUNT + 1))" | xargs rm -f 2>/dev/null
  echo "✓ Old backups cleaned up"
fi

echo "Done."
