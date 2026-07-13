#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Treasurio — Deploy to VPS (Dev + Prod)
# VPS: root@84.54.23.37
# Dev: ksji-dev.tilcsaas.com :3100
# Prod: prod-groupledger.tilcsaas.com :3200
# ============================================

VPS_HOST="84.54.23.37"
VPS_USER="root"
REMOTE_DIR="/opt/treasurio"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "============================================"
echo "  Treasurio — Deploying to VPS"
echo "  Host: ${VPS_USER}@${VPS_HOST}"
echo "  Remote: ${REMOTE_DIR}"
echo "============================================"
echo ""

# Step 1: Create remote directory structure
echo "[1/6] Preparing remote directory..."
ssh ${VPS_USER}@${VPS_HOST} "mkdir -p ${REMOTE_DIR}"

# Step 2: Sync project files to VPS (excluding node_modules, .git, etc.)
echo "[2/6] Syncing project files..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.kiro' \
  --exclude='deploy/.env' \
  --exclude='storage' \
  --exclude='*.db' \
  "${PROJECT_DIR}/" "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/"

# Step 3: Copy .env file separately (contains secrets)
echo "[3/6] Copying environment file..."
scp "${SCRIPT_DIR}/.env" "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/deploy/.env"

# Step 4: Copy Nginx configs
echo "[4/6] Setting up Nginx configs..."
scp "${SCRIPT_DIR}/nginx-dev.conf" "${VPS_USER}@${VPS_HOST}:/etc/nginx/sites-available/treasurio-dev"
scp "${SCRIPT_DIR}/nginx-prod.conf" "${VPS_USER}@${VPS_HOST}:/etc/nginx/sites-available/treasurio-prod"

ssh ${VPS_USER}@${VPS_HOST} << 'EOF'
  # Enable sites
  ln -sf /etc/nginx/sites-available/treasurio-dev /etc/nginx/sites-enabled/treasurio-dev
  ln -sf /etc/nginx/sites-available/treasurio-prod /etc/nginx/sites-enabled/treasurio-prod

  # Test and reload nginx
  nginx -t && systemctl reload nginx
  echo "  ✓ Nginx configured and reloaded"
EOF

# Step 5: Build and start containers on VPS
echo "[5/6] Building and starting containers..."
ssh ${VPS_USER}@${VPS_HOST} << EOF
  cd ${REMOTE_DIR}/deploy
  docker compose --env-file .env up -d --build
  echo ""
  echo "  Waiting for services to be healthy..."
  sleep 10
  docker compose ps
EOF

# Step 6: Run migrations on both databases
echo "[6/6] Running database migrations..."
ssh ${VPS_USER}@${VPS_HOST} << EOF
  cd ${REMOTE_DIR}/deploy
  echo "  Running migration on dev..."
  docker compose exec -T app-dev node src/migrate.js
  echo "  Running migration on prod..."
  docker compose exec -T app-prod node src/migrate.js
  echo "  ✓ Migrations complete"
EOF

echo ""
echo "============================================"
echo "  ✓ Deployment Complete!"
echo "============================================"
echo ""
echo "  Dev:  http://ksji-dev.tilcsaas.com"
echo "        → 127.0.0.1:3100"
echo ""
echo "  Prod: http://prod-groupledger.tilcsaas.com"
echo "        → 127.0.0.1:3200"
echo ""
echo "  Next steps:"
echo "    1. Point DNS for both domains to ${VPS_HOST}"
echo "    2. Run: ssh ${VPS_USER}@${VPS_HOST} certbot --nginx -d ksji-dev.tilcsaas.com -d prod-groupledger.tilcsaas.com"
echo "    3. Seed the databases:"
echo "       ssh ${VPS_USER}@${VPS_HOST} 'cd ${REMOTE_DIR}/deploy && docker compose exec app-dev node src/seed.js'"
echo "       ssh ${VPS_USER}@${VPS_HOST} 'cd ${REMOTE_DIR}/deploy && docker compose exec app-prod node src/seed.js'"
echo ""
