#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backups"
RETAIN_COUNT="${RETAIN_COUNT:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-treasurio}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$SCRIPT_DIR")}"
export COMPOSE_PROJECT_NAME

[[ "$RETAIN_COUNT" =~ ^[0-9]+$ ]] && ((RETAIN_COUNT > 0)) || {
  echo "RETAIN_COUNT must be a positive integer" >&2
  exit 2
}

install -d -m 0700 "$BACKUP_DIR"

dev_tmp="$BACKUP_DIR/dev_${TIMESTAMP}.sql.gz.tmp"
prod_tmp="$BACKUP_DIR/prod_${TIMESTAMP}.sql.gz.tmp"
uploads_dev_tmp="$BACKUP_DIR/uploads-dev_${TIMESTAMP}.tar.gz.tmp"
uploads_prod_tmp="$BACKUP_DIR/uploads-prod_${TIMESTAMP}.tar.gz.tmp"
trap 'rm -f "$dev_tmp" "$prod_tmp" "$uploads_dev_tmp" "$uploads_prod_tmp"' EXIT

publish_backup() {
  local temp_file="$1"
  local final_file="$2"
  gzip -t "$temp_file"
  mv "$temp_file" "$final_file"
  if [ -n "$S3_BUCKET" ]; then
    local key="${S3_PREFIX%/}/$(basename "$final_file")"
    local checksum remote_checksum local_size remote_size
    checksum="$(sha256sum "$final_file" | awk '{print $1}')"
    local_size="$(wc -c < "$final_file" | tr -d ' ')"
    aws s3 cp "$final_file" "s3://${S3_BUCKET}/${key}" \
      --sse AES256 --metadata "sha256=${checksum}" --only-show-errors
    remote_checksum="$(aws s3api head-object --bucket "$S3_BUCKET" --key "$key" --query 'Metadata.sha256' --output text)"
    remote_size="$(aws s3api head-object --bucket "$S3_BUCKET" --key "$key" --query 'ContentLength' --output text)"
    [[ "$remote_checksum" == "$checksum" && "$remote_size" == "$local_size" ]] || {
      echo "S3 verification failed for s3://${S3_BUCKET}/${key}" >&2
      return 1
    }
    echo "    S3 verified: s3://${S3_BUCKET}/${key}"
  fi
}

echo "Backing up both databases..."

# Backup dev
echo "  → treasurio_dev..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U treasurio -d treasurio_dev --clean --if-exists | gzip > "$dev_tmp"
publish_backup "$dev_tmp" "$BACKUP_DIR/dev_${TIMESTAMP}.sql.gz"
echo "  ✓ Dev backup: dev_${TIMESTAMP}.sql.gz"

# Backup prod
echo "  → treasurio_prod..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
  pg_dump -U treasurio -d treasurio_prod --clean --if-exists | gzip > "$prod_tmp"
publish_backup "$prod_tmp" "$BACKUP_DIR/prod_${TIMESTAMP}.sql.gz"
echo "  ✓ Prod backup: prod_${TIMESTAMP}.sql.gz"

backup_volume() {
  local volume="$1"
  local prefix="$2"
  local temp_file="$3"
  local final_file="$BACKUP_DIR/${prefix}_${TIMESTAMP}.tar.gz"

  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "  → ${volume} not created yet; skipping"
    return 0
  fi
  echo "  → ${volume}..."
  docker run --rm -v "${volume}:/data:ro" postgres:16-alpine \
    tar -C /data -czf - . > "$temp_file"
  publish_backup "$temp_file" "$final_file"
  echo "  ✓ Upload backup: $(basename "$final_file")"
}

backup_volume "${COMPOSE_PROJECT_NAME}_uploads-dev" "uploads-dev" "$uploads_dev_tmp"
backup_volume "${COMPOSE_PROJECT_NAME}_uploads-prod" "uploads-prod" "$uploads_prod_tmp"

# Retain only last N backups per environment
for prefix in dev prod uploads-dev uploads-prod; do
  extension="sql.gz"
  [[ "$prefix" == uploads-* ]] && extension="tar.gz"
  COUNT="$(find "$BACKUP_DIR" -name "${prefix}_*.${extension}" -type f | wc -l | tr -d ' ')"
  if [ "$COUNT" -gt "$RETAIN_COUNT" ]; then
    ls -t "$BACKUP_DIR"/${prefix}_*.${extension} | tail -n +$((RETAIN_COUNT + 1)) | xargs rm -f
    echo "  Cleaned old ${prefix} backups (retaining last ${RETAIN_COUNT})"
  fi
done

echo "Done."
