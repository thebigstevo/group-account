#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE=false

# Parse flags
for arg in "$@"; do
  case $arg in
    --purge)
      PURGE=true
      shift
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Usage: $0 [--purge]"
      echo ""
      echo "Options:"
      echo "  --purge  Also delete the PostgreSQL data volume (irreversible)"
      exit 1
      ;;
  esac
done

echo "============================================"
echo "  Treasurio — Remove Application"
echo "============================================"
echo ""

if [ "$PURGE" = true ]; then
  echo "WARNING: --purge flag detected. This will permanently delete all database data."
  echo ""
  read -rp "Are you sure? This cannot be undone. (yes/no): " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "Removal cancelled."
    exit 0
  fi
fi

# Stop and remove containers
echo "Stopping containers..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" down

if [ $? -eq 0 ]; then
  echo "✓ Containers stopped and removed"
else
  echo "✗ Failed to stop containers"
  exit 1
fi

# Remove the network (docker compose down already handles this, but be explicit)
echo "Removing network..."
docker network rm treasurio-net 2>/dev/null || true
echo "✓ Network removed"

# Purge data volume if requested
if [ "$PURGE" = true ]; then
  echo "Removing pgdata volume..."
  VOLUME_NAME="$(docker compose -f "$SCRIPT_DIR/docker-compose.yml" config --volumes 2>/dev/null | grep pgdata || echo "")"
  # Try project-prefixed volume name
  PROJECT_NAME="$(basename "$SCRIPT_DIR")"
  docker volume rm "${PROJECT_NAME}_pgdata" 2>/dev/null || \
    docker volume rm "treasurio_pgdata" 2>/dev/null || \
    echo "  (volume may have already been removed)"
  echo "✓ Data volume deleted"
fi

echo ""
echo "============================================"
echo "  Treasurio has been removed."
if [ "$PURGE" = false ]; then
  echo "  Database volume preserved (use --purge to delete)."
fi
echo "============================================"
