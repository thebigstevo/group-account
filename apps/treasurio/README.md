# Treasurio — Deployment Guide

Treasurio is a group and club financial management application. This directory contains the deployment scripts and configuration for running Treasurio on a VPS behind an Nginx reverse proxy.

## Directory Structure

```
apps/treasurio/
├── docker-compose.yml      # Docker Compose stack (app + PostgreSQL)
├── .env.example            # Template for environment variables
├── deploy-treasurio.sh     # Interactive deployment setup
├── backup.sh               # Database backup (pg_dump → .sql.gz)
├── restore.sh              # Database restore from backup
├── remove-treasurio.sh     # Stop and remove containers
└── README.md               # This file
```

## Quick Start

```bash
# Make scripts executable
chmod +x deploy-treasurio.sh backup.sh restore.sh remove-treasurio.sh

# Run interactive deployment
./deploy-treasurio.sh
```

The deploy script will:
1. Prompt for domain, port, database credentials, and branding
2. Generate a `.env` file with all required variables
3. Build and start the Docker containers
4. Output the Nginx configuration block to add

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PGHOST` | PostgreSQL hostname (internal) | `postgres` |
| `PGPORT` | PostgreSQL port | `5432` |
| `PGDATABASE` | Database name | `treasurio` |
| `PGUSER` | Database username | `treasurio` |
| `PGPASSWORD` | Database password | (required) |
| `APP_PORT` | Host port binding | `3100` |
| `DOMAIN` | Application domain name | (required) |
| `SESSION_SECRET` | Express session secret | (auto-generated) |
| `N8N_API_TOKEN` | n8n integration token | (auto-generated) |
| `GROUP_NAME` | Organization display name | `My Group` |
| `GROUP_CURRENCY` | Currency code for formatting | `GHS` |
| `NODE_ENV` | Node environment | `production` |

## Backup & Restore

### Creating a Backup

```bash
./backup.sh
```

Backups are saved to `backups/treasurio_YYYYMMDD_HHMMSS.sql.gz`. By default, the last 7 backups are retained. Set `RETAIN_COUNT` to change:

```bash
RETAIN_COUNT=14 ./backup.sh
```

### Restoring from Backup

```bash
./restore.sh backups/treasurio_20240115_143000.sql.gz
```

This will:
1. Confirm the destructive operation
2. Drop and recreate the database
3. Restore all data from the backup

### Automated Backups (Cron)

Add to crontab for daily backups at 2 AM:

```bash
crontab -e
# Add:
0 2 * * * /path/to/apps/treasurio/backup.sh >> /var/log/treasurio-backup.log 2>&1
```

## Removing the Application

Stop containers and preserve data:

```bash
./remove-treasurio.sh
```

Stop containers and permanently delete all data:

```bash
./remove-treasurio.sh --purge
```

## Nginx Configuration

The deploy script outputs the Nginx config automatically. For reference, the server block looks like:

```nginx
server {
    listen 80;
    server_name treasurio.example.com;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

After adding to `/etc/nginx/sites-available/treasurio`:

```bash
sudo ln -s /etc/nginx/sites-available/treasurio /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### HTTPS with Certbot

```bash
sudo certbot --nginx -d treasurio.example.com
```

## Health Check

The application exposes a health endpoint:

```bash
curl http://127.0.0.1:3100/health
```

Response when healthy:
```json
{"status": "ok", "database": "connected"}
```

Response when unhealthy (503):
```json
{"status": "error", "database": "unreachable"}
```

## Manual Operations

### View logs

```bash
docker compose logs -f accounts
docker compose logs -f postgres
```

### Restart application

```bash
docker compose restart accounts
```

### Access PostgreSQL directly

```bash
docker compose exec postgres psql -U treasurio -d treasurio
```

### Rebuild after code update

```bash
docker compose up -d --build accounts
```
