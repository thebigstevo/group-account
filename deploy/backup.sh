#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backups"
RETAIN_COUNT="${RETAIN_COUNT:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

[[ "$RETAIN_COUNT" =~ ^[0-9]+$ ]] && ((RETAIN_COUNT > 0)) || {
  echo "RETAIN_COUNT must be a positive integer" >&2
  exit 2
}
install -d -m 0700 "$BACKUP_DIR"

echo "Backing up both databases..."

# Backup dev
echo "  → treasurio_dev..."
dev_tmp="$BACKUP_DIR/dev_${TIMESTAMP}.sql.gz.tmp"
prod_tmp="$BACKUP_DIR/prod_${TIMESTAMP}.sql.gz.tmp"
trap 'rm -f "$dev_tmp" "$prod_tmp"' EXIT
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U treasurio -d treasurio_dev --clean --if-exists | gzip > "$dev_tmp"
gzip -t "$dev_tmp"
mv "$dev_tmp" "$BACKUP_DIR/dev_${TIMESTAMP}.sql.gz"
echo "  ✓ Dev backup: dev_${TIMESTAMP}.sql.gz"

# Backup prod
echo "  → treasurio_prod..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U treasurio -d treasurio_prod --clean --if-exists | gzip > "$prod_tmp"
gzip -t "$prod_tmp"
mv "$prod_tmp" "$BACKUP_DIR/prod_${TIMESTAMP}.sql.gz"
echo "  ✓ Prod backup: prod_${TIMESTAMP}.sql.gz"

# Retain only last N backups per environment
for prefix in dev prod; do
  COUNT="$(find "$BACKUP_DIR" -name "${prefix}_*.sql.gz" -type f | wc -l | tr -d ' ')"
  if [ "$COUNT" -gt "$RETAIN_COUNT" ]; then
    ls -t "$BACKUP_DIR"/${prefix}_*.sql.gz | tail -n +$((RETAIN_COUNT + 1)) | xargs rm -f
    echo "  Cleaned old ${prefix} backups (retaining last ${RETAIN_COUNT})"
  fi
done

echo "Done."
