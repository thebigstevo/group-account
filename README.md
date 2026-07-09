# KSJI Accounts

A lightweight Node.js accounts app for managing members, dues, welfare liability, cash/bank/mobile money balances, and executive reports.

## Run with Docker

```powershell
docker compose up -d --build
```

Open `http://localhost:3000`.

Default login after the first boot:

- Email: `admin@example.com`
- Password: `ChangeMe123!`

Change the default password immediately after deployment. Also change `SESSION_SECRET` and `N8N_API_TOKEN` in `docker-compose.yml`.

The SQLite database is stored in the Docker volume `ksjiaccounts_accounts_data`, so container rebuilds keep the data.

## Import workbook members with Docker

From this project folder:

```powershell
docker compose run --rm `
  -e WORKBOOK_PATH=/import/GroupManagementTemplate.xlsx `
  -v "C:\Users\steps\Downloads:/import:ro" `
  accounts npm run import:workbook
```

The importer reads the `Members` sheet and creates or updates member names, phone numbers, dates of birth, and opening arrears.

## Run locally without Docker

```powershell
npm.cmd install
npm.cmd run seed
npm.cmd start
```

Open `http://localhost:3000`.

Default login after seeding:

- Email: `admin@example.com`
- Password: `ChangeMe123!`

Change this password immediately after deployment.

## Import workbook members without Docker

```powershell
$env:WORKBOOK_PATH="C:\Users\steps\Downloads\GroupManagementTemplate.xlsx"
npm.cmd run import:workbook
```

## n8n arrears endpoint

After login/session protection is expanded for API tokens, n8n can use:

```text
GET /api/reports/member-arrears?year=2026
```

For now, set `N8N_API_TOKEN` in the environment and send:

```text
Authorization: Bearer your-token
```

## Current reports

The Reports screen is monthly. It shows:

- Gross receipts, assessment income, spends, welfare collected, welfare liability, raw balances, and estimated spendable balance.
- Raw account balances beside the most recent reconciled statement balances.
- Income and expenses by category for the selected month.
- A running balance ledger for the selected month.
- Member arrears for the selected year.

Recommended next controls:

- Password change and reset screens.
- Correction workflow for mistaken entries instead of deleting transactions.
- Backup and restore download from the Docker volume.
- Approval status for large expenses and welfare payouts.
- Statement upload/matching for bank and mobile money reconciliation.

See `PRODUCTION_READINESS.md` for deployment and system design notes before using the app for live records.
