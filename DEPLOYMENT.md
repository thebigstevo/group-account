# Treasurio — Deployment & Operations Guide

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  VPS: 84.54.23.37 (Ubuntu, Nginx 1.24, Docker, Certbot)         │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Nginx (reverse proxy + SSL termination)                     │ │
│  │   ksji-dev.tilcsaas.com → 127.0.0.1:3100            │ │
│  │   ksji825.tilcsaas.com → 127.0.0.1:3200                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Docker Compose (project: deploy)                            │ │
│  │                                                             │ │
│  │   ┌───────────────────────────────────────────────┐         │ │
│  │   │ postgres (postgres:16-alpine)                 │         │ │
│  │   │   ├── Database: treasurio_dev                 │         │ │
│  │   │   └── Database: treasurio_prod                │         │ │
│  │   │   Volume: deploy_pgdata                       │         │ │
│  │   └───────────────────────────────────────────────┘         │ │
│  │                                                             │ │
│  │   ┌──────────────────────┐  ┌──────────────────────┐       │ │
│  │   │ app-dev              │  │ app-prod             │       │ │
│  │   │ 127.0.0.1:3100:3000 │  │ 127.0.0.1:3200:3000 │       │ │
│  │   │ DB: treasurio_dev    │  │ DB: treasurio_prod   │       │ │
│  │   │ NODE_ENV=development │  │ NODE_ENV=production  │       │ │
│  │   └──────────────────────┘  └──────────────────────┘       │ │
│  │                                                             │ │
│  │   Network: deploy_treasurio-net (internal)                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Other services (unrelated, different ports):                    │
│    n8n-automation (:20081), erpnext (:19080),                    │
│    openemr-galilea (:18081), qloapps-parksprings (:21082/83)     │
└──────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Single PostgreSQL container, two databases and isolated login roles | Saves resources while preventing either application role from connecting to the other database |
| Bind to 127.0.0.1 only | Nginx handles public access; ports not directly exposed |
| Nginx config naming: `*.tilcsaas.com.conf` | Matches existing VPS convention |
| Code at `/opt/treasurio` | Doesn't conflict with other apps |
| CI/CD pulls code via git (not rsync/scp) | Simpler, faster, git history preserved on VPS |

---

## CI/CD Pipeline

### Triggers

| Branch | Workflow | Deploys |
|---|---|---|
| Pull requests and protected branches | CI | Tests, dependency audit, syntax/config validation, production-image build |
| Manual `Deploy Dev` dispatch | Deploy Dev | Selected committed branch to `app-dev` (port 3100) |
| Manual `Deploy Prod` dispatch from `master` | Deploy Prod | Reviewed `master` commit to `app-prod` (port 3200) |

### What Each Deploy Does

1. SSH into VPS as `root`
2. Clone the repository or reset the server checkout to the selected committed branch
3. Write an environment-specific, mode-0600 Compose env file
4. Provision the environment's least-privilege PostgreSQL role
5. Run tests, dependency audit, deployment validation, and image build in GitHub Actions
6. Create and verify database and upload-volume backups in S3 before production migration
7. Run the idempotent migration with the database owner, start the app, and wait for `/health`
8. Verify another S3 backup after production is healthy

### Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `VPS_HOST` | VPS IP (`84.54.23.37`) |
| `VPS_USER` | SSH user (`root`) |
| `VPS_SSH_KEY` | SSH private key used by GitHub Actions |
| `POSTGRES_PASSWORD` | Database-owner password, 24+ characters |
| `DEV_DB_PASSWORD` | Least-privilege development application role, 24+ characters |
| `PROD_DB_PASSWORD` | Least-privilege production application role, 24+ characters |
| `DEV_SESSION_SECRET` | Express session key for dev |
| `PROD_SESSION_SECRET` | Express session key for prod |
| `DEV_N8N_API_TOKEN` | n8n API token for dev |
| `PROD_N8N_API_TOKEN` | n8n API token for prod |
| `DEV_GROUP_NAME` | Organization name in dev UI |
| `PROD_GROUP_NAME` | Organization name in prod UI |

Required repository variables: `PROJECT_NAME`, `DEV_DOMAIN`, `PROD_DOMAIN`, and `BACKUP_S3_BUCKET`.

---

## Fresh Deployment (First Time)

### Prerequisites

- VPS with Docker, Docker Compose v2, Nginx, Git
- DNS A records pointing domains to VPS IP
- GitHub repo with Actions enabled

### Steps

```bash
# 1. Set DNS records (in your domain panel)
#    ksji-dev.tilcsaas.com → A → 84.54.23.37
#    ksji825.tilcsaas.com → A → 84.54.23.37

# 2. Add the GitHub Secrets and repository variables listed above

# 3. Open a pull request, wait for CI, and merge the reviewed commit
# 4. Dispatch Deploy Dev or Deploy Prod from GitHub Actions

# 4. Wait for GitHub Actions to complete (2-3 minutes)
#    Monitor at: https://github.com/thebigstevo/group-account/actions

# 5. Open the app in your browser
#    Visit: https://ksji-dev.tilcsaas.com
#    The setup wizard will appear automatically (no SSH needed!)
#    Create your admin account, set organization name, and you're done.

# 6. Enable HTTPS
ssh root@84.54.23.37
certbot --nginx -d ksji-dev.tilcsaas.com -d ksji825.tilcsaas.com
```

### Setup Wizard

On first visit after deployment, the app detects no users exist and shows a setup wizard where you:
1. Create the admin account (name, email, password)
2. Set your organization name and currency
3. Set the opening fiscal year

After completing setup, the wizard locks itself permanently. No SSH or command-line access needed.

---

## Container Management

### Check status

```bash
ssh root@84.54.23.37
cd /opt/treasurio/deploy
docker compose ps
```

Expected output:
```
NAME                  STATUS              PORTS
deploy-app-dev-1      Up (healthy)        127.0.0.1:3100->3000/tcp
deploy-app-prod-1     Up (healthy)        127.0.0.1:3200->3000/tcp
deploy-postgres-1     Up (healthy)        5432/tcp
```

### View logs

```bash
# Follow all logs
docker compose logs -f

# Specific service
docker compose logs -f app-dev
docker compose logs -f app-prod
docker compose logs -f postgres

# Last 50 lines
docker compose logs --tail 50 app-dev
```

### Restart services

```bash
# Restart app (no rebuild)
docker compose restart app-dev
docker compose restart app-prod

# Rebuild and restart (after manual code change)
docker compose up -d --build app-dev
docker compose up -d --build app-prod

# Restart everything
docker compose restart
```

### Stop services

```bash
# Stop all (containers preserved, data preserved)
docker compose stop

# Stop specific service
docker compose stop app-dev
```

### Start after stop

```bash
docker compose start
```

### Shell into container

```bash
# App container
docker compose exec app-dev sh
docker compose exec app-prod sh

# PostgreSQL
docker compose exec postgres psql -U treasurio -d treasurio_dev
docker compose exec postgres psql -U treasurio -d treasurio_prod
```

---

## Database Operations

### Connect to PostgreSQL

```bash
cd /opt/treasurio/deploy

# Dev database
docker compose exec postgres psql -U treasurio -d treasurio_dev

# Prod database
docker compose exec postgres psql -U treasurio -d treasurio_prod

# List all databases
docker compose exec postgres psql -U treasurio -l
```

### Run migrations manually

```bash
docker compose exec -T app-dev node src/migrate.js
docker compose exec -T app-prod node src/migrate.js
```

### Seed admin user (only if wizard wasn't used)

```bash
docker compose exec app-dev node src/seed.js
docker compose exec app-prod node src/seed.js
```

Note: The setup wizard is the preferred way to create the first admin. The seed script is a fallback for headless/automated deployments.

### Check table row counts

```bash
docker compose exec postgres psql -U treasurio -d treasurio_prod -c "
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;"
```

---

## Backup & Restore

### Manual S3-verified Backup

```bash
cd /opt/treasurio/deploy
S3_BUCKET=treasurio-backups-390403853790 RETAIN_COUNT=30 ./backup.sh
```

The script archives both databases and both upload volumes, validates gzip integrity, uploads with AES-256 server-side encryption and a SHA-256 metadata checksum, and verifies the remote object size and checksum.

### Automated Daily Backup (Cron)

```cron
S3_BUCKET=treasurio-backups-390403853790
S3_PREFIX=treasurio
47 4 * * * root umask 077; RETAIN_COUNT=30 /opt/treasurio/deploy/backup.sh >> /var/log/treasurio-backup.log 2>&1
```

### Restore from Backup

```bash
cd /opt/treasurio/deploy

# The command requires typing the exact database/volume name before replacement.
PROD_DB_PASSWORD='value-from-secure-store' ./restore.sh database prod \
  s3://treasurio-backups-390403853790/treasurio/prod_YYYYMMDD_HHMMSS.sql.gz
PROD_DB_PASSWORD='value-from-secure-store' ./restore.sh uploads prod \
  s3://treasurio-backups-390403853790/treasurio/uploads-prod_YYYYMMDD_HHMMSS.tar.gz
```

### Restore to a completely fresh database

If the database is corrupted and you need a clean slate:

```bash
cd /opt/treasurio/deploy

# Stop app
docker compose stop app-prod

# Drop and recreate database
docker compose exec -T postgres psql -U treasurio -d postgres -c "DROP DATABASE IF EXISTS treasurio_prod;"
docker compose exec -T postgres psql -U treasurio -d postgres -c "CREATE DATABASE treasurio_prod OWNER treasurio;"

# Restore from backup
gunzip -c /opt/treasurio/backups/prod_20260808_020000.sql.gz | \
  docker compose exec -T postgres psql -U treasurio -d treasurio_prod --quiet

# Start app
docker compose start app-prod
```

### Copy prod data to dev (for testing)

```bash
cd /opt/treasurio/deploy

# Dump prod
docker compose exec -T postgres pg_dump -U treasurio -d treasurio_prod --clean --if-exists | \
  docker compose exec -T postgres psql -U treasurio -d treasurio_dev --quiet

echo "Prod data copied to dev"
```

---

## Recovery Scenarios

### Scenario 1: App container crashed

**Symptom:** Site shows 502 Bad Gateway

```bash
cd /opt/treasurio/deploy

# Check what happened
docker compose logs --tail 30 app-dev

# Restart it
docker compose restart app-dev

# If restart fails, rebuild
docker compose up -d --build app-dev
```

### Scenario 2: PostgreSQL crashed

**Symptom:** Both sites show errors, "database: unreachable" on /health

```bash
cd /opt/treasurio/deploy

# Check postgres logs
docker compose logs --tail 50 postgres

# Restart postgres
docker compose restart postgres

# Wait for healthcheck
sleep 10
docker compose ps

# Restart apps (they may need reconnection)
docker compose restart app-dev app-prod
```

### Scenario 3: PostgreSQL data corruption

**Symptom:** Query errors, unexpected results, postgres won't start

```bash
cd /opt/treasurio/deploy

# Stop everything
docker compose down

# Remove ONLY the postgres volume (DESTROYS ALL DATA)
docker volume rm deploy_pgdata

# Start fresh postgres
docker compose up -d postgres
sleep 10

# Restore from latest backup
LATEST=$(ls -t /opt/treasurio/backups/prod_*.sql.gz | head -1)
gunzip -c "$LATEST" | docker compose exec -T postgres psql -U treasurio -d treasurio_prod --quiet

# Start apps
docker compose up -d app-dev app-prod
docker compose exec -T app-dev node src/migrate.js
docker compose exec -T app-prod node src/migrate.js
```

### Scenario 4: Disk full

```bash
# Check disk usage
df -h

# Clean Docker resources
docker system prune -a --volumes --filter "until=168h"

# Remove old backups
find /opt/treasurio/backups -name "*.sql.gz" -mtime +7 -delete

# Remove old Docker images
docker image prune -a
```

### Scenario 5: Need to roll back a bad deploy

```bash
cd /opt/treasurio

# Check recent commits
git log --oneline -10

# Roll back to previous commit
git reset --hard HEAD~1

# Rebuild
cd deploy
docker compose up -d --build app-dev app-prod
```

### Scenario 6: Complete rebuild from scratch

```bash
cd /opt/treasurio/deploy

# Backup everything first
docker compose exec -T postgres pg_dump -U treasurio -d treasurio_dev --clean | gzip > /opt/treasurio/backups/dev_pre-rebuild.sql.gz
docker compose exec -T postgres pg_dump -U treasurio -d treasurio_prod --clean | gzip > /opt/treasurio/backups/prod_pre-rebuild.sql.gz

# Tear down
docker compose down -v
rm -rf /opt/treasurio

# Remove nginx configs
rm -f /etc/nginx/sites-enabled/ksji-dev.tilcsaas.com.conf
rm -f /etc/nginx/sites-enabled/ksji825.tilcsaas.com.conf
nginx -t && systemctl reload nginx

# Now dispatch the appropriate deployment workflow from GitHub Actions
# After deploy completes, restore backups:
cd /opt/treasurio/deploy
gunzip -c /opt/treasurio/backups/dev_pre-rebuild.sql.gz | docker compose exec -T postgres psql -U treasurio -d treasurio_dev
gunzip -c /opt/treasurio/backups/prod_pre-rebuild.sql.gz | docker compose exec -T postgres psql -U treasurio -d treasurio_prod
```

---

## Nginx Management

### Check current configs

```bash
ls /etc/nginx/sites-enabled/
# Expected: ksji-dev.tilcsaas.com.conf, ksji825.tilcsaas.com.conf, (plus your other apps)
```

### View a config

```bash
cat /etc/nginx/sites-enabled/ksji-dev.tilcsaas.com.conf
```

### Test and reload after changes

```bash
nginx -t && systemctl reload nginx
```

### Renew SSL certificates

```bash
# Auto-renewal (certbot sets this up)
certbot renew --dry-run

# Force renewal
certbot renew --force-renewal
```

---

## Health Checks

### Application health

```bash
# From VPS
curl http://127.0.0.1:3100/health    # dev
curl http://127.0.0.1:3200/health    # prod

# Expected response (200 OK):
# {"status":"ok","database":"connected"}

# If database is down (503):
# {"status":"error","database":"unreachable"}
```

### From outside

```bash
curl https://ksji-dev.tilcsaas.com/health
curl https://ksji825.tilcsaas.com/health
```

### Docker healthcheck

```bash
docker compose ps
# Look for "healthy" status on postgres
```

---

## Deploying for a New Client

To deploy Treasurio for a different organization:

1. **Fork the repo** (or reuse it with different branches/secrets)
2. **Point new domains** to the VPS (or a different VPS)
3. **Update GitHub Secrets** with:
   - New VPS credentials (if different server)
   - New `PROD_GROUP_NAME` (e.g., "Rotary Club of Accra")
   - New `GROUP_CURRENCY` if needed
4. **Change domains** in workflow files (search for `tilcsaas.com`)
5. **Change ports** in `deploy/docker-compose.yml` if same VPS (e.g., 3300/3400)
6. **Dispatch** the environment's deployment workflow for the reviewed commit
7. **Seed** admin user
8. **Certbot** for HTTPS

No code changes needed — the app is fully white-labeled via `GROUP_NAME` and `GROUP_CURRENCY` environment variables.

---

## File Structure (VPS)

```
/opt/treasurio/
├── deploy/
│   ├── docker-compose.yml      # 3 services: postgres, app-dev, app-prod
│   ├── init-databases.sql      # Creates treasurio_dev DB on first boot
│   ├── .env.dev                # Dev secrets (written by CI/CD, never committed)
│   └── .env.prod               # Prod secrets (written by CI/CD, never committed)
├── src/                        # Application code
│   ├── server.js               # Express app
│   ├── dal.js                  # PostgreSQL data access layer
│   ├── migrate.js              # Database schema migration
│   ├── seed.js                 # Default admin user seeder
│   ├── services.js             # Business logic
│   ├── public/                 # CSS + client JS
│   └── views/                  # EJS templates
├── Dockerfile                  # Multi-stage Alpine build
├── package.json
└── ...

/opt/treasurio/backups/           # Database backups (create manually)
  ├── dev_20260808_020000.sql.gz
  └── prod_20260808_020000.sql.gz

/etc/nginx/sites-enabled/
  ├── ksji-dev.tilcsaas.com.conf   # → 127.0.0.1:3100
  └── ksji825.tilcsaas.com.conf  # → 127.0.0.1:3200
```

---

## Quick Reference

| Task | Command |
|---|---|
| Deploy dev | Dispatch `Deploy Dev` for the committed development branch |
| Deploy prod | Dispatch `Deploy Prod` from reviewed `master` |
| View dev logs | `cd /opt/treasurio/deploy && docker compose logs -f app-dev` |
| View prod logs | `cd /opt/treasurio/deploy && docker compose logs -f app-prod` |
| Restart dev | `cd /opt/treasurio/deploy && docker compose restart app-dev` |
| Restart prod | `cd /opt/treasurio/deploy && docker compose restart app-prod` |
| Backup prod | `docker compose exec -T postgres pg_dump -U treasurio -d treasurio_prod --clean \| gzip > backup.sql.gz` |
| Restore prod | `gunzip -c backup.sql.gz \| docker compose exec -T postgres psql -U treasurio -d treasurio_prod` |
| Run migration | `docker compose exec -T app-prod node src/migrate.js` |
| Seed admin | `docker compose exec app-prod node src/seed.js` (or use web wizard) |
| Check health | `curl http://127.0.0.1:3200/health` |
| Access DB | `docker compose exec postgres psql -U treasurio -d treasurio_prod` |
| Full reset | `docker compose down -v && rm -rf /opt/treasurio` |
