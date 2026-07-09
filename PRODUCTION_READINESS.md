# Production Readiness Notes

## Architecture

- Node.js 22 + Express 4 + EJS templates + SQLite (better-sqlite3).
- Dockerized with `docker-compose.yml`; persistent data in named volume `ksjiaccounts_accounts_data`.
- Single-process, single-file database — suitable for low-concurrency church group use.
- No external dependencies beyond npm packages.

## Security hardening (completed)

| Control | Implementation |
|---------|---------------|
| Security headers | Helmet with strict CSP (self-only scripts, styles, images, fonts) |
| CSRF protection | Custom token-based via `crypto.randomBytes`; stored in session; validated on all POST; API routes (`/api/`) excluded |
| Global rate limiting | 100 requests / 15 min per IP (express-rate-limit) |
| Login rate limiting | 10 attempts / 15 min per IP |
| Password hashing | PBKDF2-SHA256, 210 000 iterations, 16-byte salt |
| Session storage | SQLite-backed (not in-memory); httpOnly, sameSite=lax cookies |
| Secure cookies | Enabled when `SECURE_COOKIES=1` (set when behind HTTPS) |
| Production secret enforcement | App refuses to start if `SESSION_SECRET` is default in `NODE_ENV=production` |
| Role-based access | 5 roles: admin, finance_secretary, treasurer, auditor, viewer |
| Audit logging | All sensitive actions logged with user ID, IP, entity, before/after values |
| Transaction integrity | Reversal workflow — no physical deletes; reversed status excludes from calculations |
| CSRF tokens in templates | Every form includes `partials/csrf.ejs` hidden field |
| API authentication | Bearer token for n8n integration (`N8N_API_TOKEN`) |

## Features (completed)

- Dashboard with balances, welfare liability, spendable estimate, work queue.
- Members register with search, add, edit, opening arrears.
- Configurable dues rules (age-based) with per-member overrides.
- Configurable payment splits (assessment → welfare ratio).
- Configurable transaction categories (income/expense, sort order).
- Receipts, expenses, welfare payouts, inter-account transfers.
- Auto-calculated welfare component from config rules.
- Transaction reconciliation (clear/unclear toggle).
- Transaction reversal with audit trail.
- Reconciliation records with statement vs system balance.
- Monthly executive report (income, expenses, running balance, arrears).
- Downloadable CSV reports: Income & Expenditure, Receipts & Payments, Welfare Fund, Financial Position, Member Statement.
- CSV exports: transactions, arrears, report summary, reconciliations, audit log.
- User management: add, activate/deactivate, admin password reset.
- Self-service password change.
- Workbook import from Excel (Members sheet).
- Web-based CSV/XLSX member import with flexible column matching (Members → Import).
- n8n API endpoint for member arrears with SMS message text.
- Print-friendly report page.
- Client-side table search and auto-date fill.

## Remaining work

### High priority (before live use)

1. **Session cleanup** — `SQLiteSessionStore` never prunes expired rows. Add a periodic cleanup (e.g. on every 100th request or a setInterval).
2. **500 error handler** — No catch-all error middleware. Unhandled DB or runtime errors show Express default HTML.
3. **HTTPS / reverse proxy** — App listens on HTTP only. Deploy behind nginx or Caddy with TLS. Then set `SECURE_COOKIES=1`.
4. **Replace default secrets** — Change `SESSION_SECRET` and `N8N_API_TOKEN` in `docker-compose.yml` before real deployment.

### Medium priority

5. **Period close / lock** — Prevent modifications to transactions in reconciled or closed months.
6. **Database backup endpoint** — Admin-only route to download the SQLite file for off-site backup.
7. **Approval workflow** — Require second-user approval for large expenses or welfare payouts above a threshold.

### Low priority / cleanup

8. **Remove `login.html`** — Unused static file at project root (leftover from prototyping).
9. **Gitignore `.history/`** — Local history directory should not be tracked.
10. **Remove `storage/test.db`** — Test artifact that should not be committed.
11. **Statement upload / matching** — For bank and mobile money reconciliation at scale.
12. **Integer currency** — Migrate `REAL` columns to integer pesewas before large-scale use to avoid floating-point drift.

## Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | 3000 | Server port |
| `DB_PATH` | `./storage/accounts.db` | SQLite file location |
| `SESSION_SECRET` | `dev-secret-change-in-production` | **Must change in production** |
| `N8N_API_TOKEN` | `dev-n8n-token` | Bearer token for API access |
| `NODE_ENV` | (unset) | Set to `production` to enforce secret and enable optimizations |
| `SECURE_COOKIES` | `0` | Set to `1` when serving over HTTPS |
| `WORKBOOK_PATH` | (unset) | Path to Excel file for member import |

## Accounting design note

Welfare collected from assessments is treated as a liability, not spendable income. The dashboard shows both total raw cash position and an estimated spendable balance after subtracting welfare liability.

## Docker commands

```powershell
# Start
docker compose up -d --build

# Import workbook
docker compose run --rm `
  -e WORKBOOK_PATH=/import/GroupManagementTemplate.xlsx `
  -v "C:\Users\steps\Downloads:/import:ro" `
  accounts npm run import:workbook

# Backup database
docker compose cp accounts:/app/storage/accounts.db ./backup-accounts.db

# View logs
docker compose logs -f accounts
```

## Local development

```powershell
npm.cmd install
npm.cmd run seed
npm.cmd start        # http://localhost:3000
npm.cmd test         # Jest tests
```

Default login: `admin@example.com` / `ChangeMe123!`
