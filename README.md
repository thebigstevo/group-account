# Treasurio — Group & Club Financial Management

A lightweight, self-hosted financial management application for groups, clubs, and societies. Track member dues, record receipts and expenses, manage welfare funds, reconcile accounts, and generate reports — all from a clean, responsive web interface.

## Features

- **Member Management** — Track members, dues, arrears, and welfare eligibility
- **Transaction Recording** — Receipts, expenses, transfers, and welfare payouts with full audit trail
- **Account Balances** — Cash, bank, and mobile money accounts with reconciliation support
- **Dues & Assessments** — Per-fiscal-year age bands, amounts, member overrides, and welfare splits managed by administrators
- **Financial Configuration** — Administrators can add, edit, deactivate, or safely remove accounts and transaction categories without relying on fixed category names
- **Reports** — Monthly summaries, arrears reports, income/expense breakdowns, running balance ledgers
- **CSV Export** — Export transactions, arrears, reports, reconciliations, and audit logs
- **Fiscal Year Management** — Open/close fiscal years with arrears carry-forward
- **Role-Based Access** — Admin, finance secretary, treasurer, viewer, and auditor roles
- **Audit Log** — Every action is logged with user, timestamp, and details
- **Responsive UI** — Works on desktop, tablet, and mobile (down to 320px)
- **Print-Friendly** — Clean print layouts for reports and transaction lists
- **Health Endpoint** — `GET /health` for load balancer and monitoring checks

## Quick Start with Docker Compose

```bash
# Clone the repository
git clone <your-repo-url> treasurio
cd treasurio

# Copy and configure environment
cp .env.example .env
# Edit .env with your values (especially SESSION_SECRET and PGPASSWORD)

# Start the stack
docker compose up -d --build
```

Open `http://localhost:3100`.

Default login after first boot:
- Email: `admin@example.com`
- Password: `ChangeMe123!`

Change the default password immediately after deployment.

On a fresh installation, open the fiscal year first, then use **Configuration** and **Dues** to create the organization's accounts, transaction categories, accounting purposes, and annual dues rules. Business-specific financial data is intentionally not seeded by migrations.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | Full PostgreSQL connection string (takes precedence over individual vars) |
| `PGHOST` | `localhost` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `treasurio` | Database name |
| `PGUSER` | `treasurio` | Database user |
| `PGPASSWORD` | — | Database password |
| `PG_POOL_SIZE` | `10` | Connection pool size (1–100) |
| `PORT` | `3000` | Application listen port (inside container) |
| `APP_PORT` | `3100` | Host port for Docker Compose mapping |
| `DOMAIN` | — | Domain for reverse proxy configuration |
| `SESSION_SECRET` | — | Session encryption secret (required in production) |
| `N8N_API_TOKEN` | — | API token for n8n webhook integrations |
| `GROUP_NAME` | `My Group` | Organization name shown in UI and reports |
| `GROUP_CURRENCY` | `GHS` | Currency code for monetary formatting |
| `NODE_ENV` | `development` | Set to `production` for secure cookies |
| `SECURE_COOKIES` | `0` | Set to `1` when behind HTTPS |

## Development Setup

Prerequisites:
- Node.js 22+
- PostgreSQL 16+ (or use Docker)

```bash
# Install dependencies
npm install

# Start PostgreSQL (if using Docker for DB only)
docker compose up -d postgres

# Run database migrations
npm run migrate

# Seed default data
npm run seed

# Start the development server
npm start
```

After the first sign-in, Treasurio requires an administrator to open or select the active fiscal year before operational pages, transactions, or member-balance imports can be used.

The app starts on `http://localhost:3000`.

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the application server |
| `npm run migrate` | Run idempotent database migrations |
| `npm run seed` | Seed default admin user and dues rules |
| `npm test` | Run unit tests |
| `npm run test:properties` | Run property-based tests |
| `npm run import:workbook` | Import members into the active fiscal year from an Excel workbook |

## Database

Treasurio uses PostgreSQL 16. The schema is managed by an idempotent migration script (`src/migrate.js`) that runs automatically on container start.

### Migrating from SQLite

If you have an existing SQLite database from a previous version, use the migration tool:

```bash
# Set the path to your SQLite database
export SQLITE_PATH=./storage/accounts.db

# Ensure PostgreSQL is running and empty
docker compose up -d postgres

# Run the migration
node src/tools/migrate-sqlite-to-pg.js
```

The tool will:
1. Validate the source SQLite file
2. Check that target PostgreSQL tables are empty
3. Migrate all data in dependency order within a single transaction
4. Reset sequences to correct values
5. Verify row counts match

### Connection Configuration

The app connects to PostgreSQL using either:
- `DATABASE_URL` — a full connection string (takes precedence), or
- Individual variables: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`

## Deployment

For production VPS deployment, see the `apps/treasurio/` directory which contains:

- `deploy-treasurio.sh` — Interactive setup script (generates .env, outputs nginx config)
- `backup.sh` — Automated PostgreSQL backup (retains last 7)
- `restore.sh` — Restore from a backup file
- `remove-treasurio.sh` — Clean removal (with optional `--purge` for data)
- `README.md` — Detailed deployment documentation

### Production Checklist

1. Set a strong `SESSION_SECRET` (32+ random characters)
2. Set a strong `PGPASSWORD`
3. Set `NODE_ENV=production` and `SECURE_COOKIES=1`
4. Configure nginx as a reverse proxy with TLS
5. Change the default admin password immediately after first login
6. Set `GROUP_NAME` and `GROUP_CURRENCY` for your organization

## Architecture

```
Express 4 + EJS (server-rendered)
        │
        ├── src/server.js      — Routes & middleware
        ├── src/services.js    — Business logic
        ├── src/dal.js         — Data access layer (pg pool)
        ├── src/config.js      — Environment configuration
        ├── src/migrate.js     — Schema migrations
        └── src/public/        — CSS & client-side JS
                │
                └── PostgreSQL 16 (via Docker)
```

## License

Private — All rights reserved.
