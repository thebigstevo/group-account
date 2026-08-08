# Treasurio — Deployment Guide

This guide covers deploying Treasurio (dev + prod) on a VPS using GitHub Actions CI/CD.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  VPS (84.54.23.37)                                      │
│                                                         │
│  Nginx (reverse proxy)                                  │
│    ├── dev-groupledger.tilcsaas.com → 127.0.0.1:3100   │
│    └── prod-groupledger.tilcsaas.com → 127.0.0.1:3200  │
│                                                         │
│  Docker Compose Stack                                   │
│    ├── postgres (shared, 2 databases)                   │
│    ├── app-dev  (port 3100, db: treasurio_dev)          │
│    └── app-prod (port 3200, db: treasurio_prod)         │
└─────────────────────────────────────────────────────────┘
```

## Prerequisites

- VPS with Docker, Docker Compose, Nginx, and Git installed
- Domain DNS records pointing to the VPS IP
- GitHub repository with Actions enabled

---

## Fresh Deployment (Step-by-Step)

### Step 1: DNS Setup

In your domain registrar, create A records:

```
dev-groupledger.tilcsaas.com  → A → 84.54.23.37
prod-groupledger.tilcsaas.com → A → 84.54.23.37
```

Allow 5–15 minutes for DNS propagation.

### Step 2: Add GitHub Secrets

Go to: **GitHub Repo → Settings → Secrets and variables → Actions → New repository secret**

Add these 10 secrets:

| Secret Name | Description | Example |
|---|---|---|
| `VPS_HOST` | VPS IP address | `84.54.23.37` |
| `VPS_USER` | SSH username | `root` |
| `VPS_PASSWORD` | SSH password | (your root password) |
| `POSTGRES_PASSWORD` | PostgreSQL password | `Str0ng_P@ssw0rd!` |
| `DEV_SESSION_SECRET` | Session encryption key (dev) | Any 32+ char random string |
| `PROD_SESSION_SECRET` | Session encryption key (prod) | Different 32+ char random string |
| `DEV_N8N_API_TOKEN` | n8n webhook token (dev) | Any token string |
| `PROD_N8N_API_TOKEN` | n8n webhook token (prod) | Any token string |
| `DEV_GROUP_NAME` | Organization name shown in dev UI | `KSJI (Dev)` |
| `PROD_GROUP_NAME` | Organization name shown in prod UI | `KSJI` |

To generate random secrets:
```bash
openssl rand -hex 32
```

### Step 3: Deploy Dev

Push to the `feature/treasurio-overhaul` or `develop` branch:

```bash
git push origin feature/treasurio-overhaul
```

This triggers the **"Deploy Dev"** workflow which:
1. SSHs into the VPS
2. Clones the repo to `/opt/treasurio`
3. Writes the `.env` file from GitHub Secrets
4. Creates the Nginx site config (first deploy only)
5. Builds the Docker image
6. Starts `postgres` + `app-dev` containers
7. Runs database migrations

Monitor progress at: https://github.com/thebigstevo/group-account/actions

### Step 4: Deploy Prod

Merge to `master` (or push directly):

```bash
git checkout master
git merge feature/treasurio-overhaul
git push origin master
```

This triggers the **"Deploy Prod"** workflow (same steps but for the prod container on port 3200).

### Step 5: Seed Admin User

After first deployment, create the initial admin account:

```bash
ssh root@84.54.23.37

# Seed dev
cd /opt/treasurio/deploy
docker compose exec app-dev node src/seed.js

# Seed prod
docker compose exec app-prod node src/seed.js
```

Default credentials:
- **Email:** `admin@example.com`
- **Password:** `ChangeMe123!`

⚠️ Change this password immediately after first login.

### Step 6: HTTPS (SSL Certificates)

```bash
ssh root@84.54.23.37
certbot --nginx -d dev-groupledger.tilcsaas.com -d prod-groupledger.tilcsaas.com
```

Certbot will automatically modify the Nginx configs to handle HTTPS.

---

## CI/CD Flow

| Trigger | Workflow | Action |
|---|---|---|
| Push to `feature/treasurio-overhaul` or `develop` | Deploy Dev | Rebuilds & deploys dev container |
| Push to `master` or `main` | Deploy Prod | Rebuilds & deploys prod container |

Each deploy:
- Pulls latest code on the VPS
- Rebuilds the Docker image (includes `npm ci`)
- Restarts the app container (zero-downtime via Docker)
- Runs database migrations (idempotent — safe to run repeatedly)

---

## Common Operations

### View logs

```bash
ssh root@84.54.23.37
cd /opt/treasurio/deploy
docker compose logs -f app-dev     # dev logs
docker compose logs -f app-prod    # prod logs
docker compose logs -f postgres    # database logs
```

### Restart a service

```bash
docker compose restart app-dev
docker compose restart app-prod
```

### Check container status

```bash
docker compose ps
```

### Access PostgreSQL directly

```bash
# Dev database
docker compose exec postgres psql -U treasurio -d treasurio_dev

# Prod database
docker compose exec postgres psql -U treasurio -d treasurio_prod
```

### Run a manual migration

```bash
docker compose exec app-dev node src/migrate.js
docker compose exec app-prod node src/migrate.js
```

---

## Backup & Restore

### Create backup

```bash
cd /opt/treasurio/deploy

# Backup dev
docker compose exec -T postgres pg_dump -U treasurio -d treasurio_dev --clean | gzip > backup_dev_$(date +%Y%m%d).sql.gz

# Backup prod
docker compose exec -T postgres pg_dump -U treasurio -d treasurio_prod --clean | gzip > backup_prod_$(date +%Y%m%d).sql.gz
```

### Restore from backup

```bash
# Restore dev
gunzip -c backup_dev_20260808.sql.gz | docker compose exec -T postgres psql -U treasurio -d treasurio_dev

# Restore prod
gunzip -c backup_prod_20260808.sql.gz | docker compose exec -T postgres psql -U treasurio -d treasurio_prod
```

### Automated daily backups (cron)

```bash
crontab -e
# Add:
0 2 * * * cd /opt/treasurio/deploy && docker compose exec -T postgres pg_dump -U treasurio -d treasurio_prod --clean | gzip > /opt/treasurio/backups/prod_$(date +\%Y\%m\%d).sql.gz
```

---

## Full Reset (Nuclear Option)

To wipe everything and start fresh:

```bash
ssh root@84.54.23.37
cd /opt/treasurio/deploy
docker compose down -v              # Stop containers, delete database volume
rm -rf /opt/treasurio               # Remove all code
rm -f /etc/nginx/sites-enabled/dev-groupledger.tilcsaas.com.conf
rm -f /etc/nginx/sites-enabled/prod-groupledger.tilcsaas.com.conf
nginx -t && systemctl reload nginx  # Reload nginx
```

Then re-run from Step 3 above.

---

## Deploying for a Different Client

To deploy Treasurio for another organization:

1. **Fork or clone** the repo
2. **Change domains** in the workflow files (`.github/workflows/deploy-*.yml`)
3. **Change ports** if needed (in `deploy/docker-compose.yml` and workflow nginx configs)
4. **Set new GitHub Secrets** with the client's VPS credentials and preferences
5. **Update `GROUP_NAME`** secret to the client's organization name
6. **Update `GROUP_CURRENCY`** in `deploy/docker-compose.yml` if not GHS
7. Push to trigger deploy

The application is fully white-labeled via environment variables — no code changes needed for different organizations.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| SSH auth fails in GitHub Actions | Check `VPS_PASSWORD` secret is correct |
| Nginx 502 Bad Gateway | Container not running — check `docker compose ps` |
| Database connection refused | Postgres not healthy — check `docker compose logs postgres` |
| Migration fails | Check if database exists — `docker compose exec postgres psql -U treasurio -l` |
| Port conflict | Another service using 3100/3200 — check `ss -tlnp | grep 3100` |
| Container won't start | Check logs: `docker compose logs app-dev` |
| Disk full | Clean old images: `docker system prune -a` |

---

## File Structure on VPS

```
/opt/treasurio/
├── deploy/
│   ├── docker-compose.yml    # Service definitions
│   ├── init-databases.sql    # Creates treasurio_dev on first boot
│   └── .env                  # Secrets (written by CI/CD)
├── src/                      # Application source
├── Dockerfile                # Multi-stage build
├── package.json
└── ...
```
