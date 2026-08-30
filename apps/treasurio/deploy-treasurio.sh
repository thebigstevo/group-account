#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

echo "============================================"
echo "  Treasurio — Deployment Setup"
echo "============================================"
echo ""

# Interactive prompts
read -rp "Enter domain name (e.g., treasurio.example.com): " DOMAIN
read -rp "Enter application port [3100]: " APP_PORT
APP_PORT="${APP_PORT:-3100}"

read -rp "Enter PostgreSQL database name [treasurio]: " PGDATABASE
PGDATABASE="${PGDATABASE:-treasurio}"

read -rp "Enter PostgreSQL username [treasurio]: " PGUSER
PGUSER="${PGUSER:-treasurio}"

read -rsp "Enter PostgreSQL password: " PGPASSWORD
echo ""

read -rp "Enter group/organization name [My Group]: " GROUP_NAME
GROUP_NAME="${GROUP_NAME:-My Group}"

read -rp "Enter currency code [GHS]: " GROUP_CURRENCY
GROUP_CURRENCY="${GROUP_CURRENCY:-GHS}"

# Generate SESSION_SECRET
SESSION_SECRET="$(openssl rand -hex 32)"

# Generate N8N_API_TOKEN
read -rp "Enter n8n API token (leave blank to auto-generate): " N8N_API_TOKEN
if [ -z "$N8N_API_TOKEN" ]; then
  N8N_API_TOKEN="$(openssl rand -hex 16)"
fi

# Write .env file
cat > "$ENV_FILE" <<EOF
# Treasurio — Generated Environment Variables
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# PostgreSQL
PGHOST=postgres
PGPORT=5432
PGDATABASE=${PGDATABASE}
PGUSER=${PGUSER}
PGPASSWORD=${PGPASSWORD}

# Application
APP_PORT=${APP_PORT}
DOMAIN=${DOMAIN}
SESSION_SECRET=${SESSION_SECRET}
N8N_API_TOKEN=${N8N_API_TOKEN}
NODE_ENV=production

# Branding
GROUP_NAME=${GROUP_NAME}
GROUP_CURRENCY=${GROUP_CURRENCY}
EOF

chmod 600 "$ENV_FILE"
echo ""
echo "✓ .env file generated at $ENV_FILE"
echo ""

# Start containers
echo "Starting Treasurio containers..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d --build
echo ""
echo "✓ Containers started successfully"
echo ""

# Output Nginx config
echo "============================================"
echo "  Nginx Configuration"
echo "============================================"
echo ""
echo "Add the following server block to your Nginx configuration:"
echo ""
cat <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

echo ""
echo "After adding the Nginx config, run:"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "For HTTPS, use certbot:"
echo "  sudo certbot --nginx -d ${DOMAIN}"
echo ""
echo "============================================"
echo "  Deployment complete!"
echo "============================================"
