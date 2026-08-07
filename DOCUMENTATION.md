# Treasurio — Application Documentation

## Overview

Treasurio is a financial management and membership administration system built for the Knights of St. John International (KSJI) commanderies. It manages member records, tracks financial contributions, handles welfare fund accounting, monitors event attendance, and communicates with members via SMS.

**Stack:** Node.js, Express, PostgreSQL, EJS templates, PDFKit, Docker  
**Deployment:** GitHub Actions CI/CD → VPS with Docker Compose  
**URL (Dev):** https://ksji-dev.tilcsaas.com  
**URL (Prod):** https://prod-groupledger.tilcsaas.com

---

## 1. Member Management

### Features
- Register members with full biographical details (name, title, phone, DOB, occupation, parish, address)
- Auto-generated membership numbers (KSJI-000001 format)
- Member status tracking: Active, Suspended, Expelled, Transferred, Resigned
- Status change history with reasons, dates, and supporting references
- Emergency contacts per member
- Rank history (degrees 1–5, conferring authority, dates)
- Position history (local, district, grand, supreme levels)
- Transfer records for members joining from other commanderies
- Profile photos
- CSV/Excel bulk import with rollback capability

### Design Decisions
- **No deletion of members with financial history** — to preserve audit trail integrity. Use status changes instead.
- **Membership number is immutable** — assigned once, never changes, ensures unique identification across all records.
- **Status changes require a reason** — enforces accountability and creates a paper trail.
- **Rank/position history is append-only** — historical records are never modified, only new entries added.

---

## 2. Financial Operations

### Features
- **Income recording** — single and batch entry for member assessments and other receipts
- **Expense recording** — with category, account, reference, and optional attachments
- **Inter-account transfers**
- **Transaction reversal** — no deletion; reversed transactions remain visible with "Reversed" badge
- **Reconciliation** — compare system balances against bank statements
- **Multiple accounts** — Republic Bank, Cash, Mobile Money, Welfare Fund

### The Welfare Split Mechanism

When a member pays their assessment (e.g. GHS 600), the system automatically splits it:
- **Operating portion** (e.g. GHS 500) → deposited into the receiving account (Bank/Cash/MoMo)
- **Welfare portion** (e.g. GHS 100) → deposited into the Welfare Fund account

This split is configured in **Settings → Payment Splits** per category and year. The member makes one payment; the system creates two transaction records internally.

### Design Decisions
- **Welfare is NOT operational income** — welfare collections are a restricted fund held on behalf of members. They appear only on the Welfare tab and Welfare Fund Statement, never in the Income list or I&E report.
- **No hard deletes** — transactions are reversed, creating an offsetting entry. This preserves the audit trail.
- **Fiscal year gating** — transactions can only be entered within the active fiscal year. The date picker enforces this with min/max attributes.
- **Batch entry** — designed for monthly meeting collections where 20+ members pay at once. One date, one category, multiple amounts.

---

## 3. Accounts & Fund Structure

| Account | Purpose |
|---------|---------|
| Republic Bank | Primary bank account for operational funds |
| Cash | Physical cash held by treasurer |
| MOMO | Mobile money account |
| Welfare Fund | Restricted fund — welfare collections only |

### How Figures Appear Across the App

| Page | What it shows |
|------|---------------|
| Income tab | Operational receipts only (excludes welfare fund account) |
| Welfare tab | Per-member welfare contributions |
| Expenses tab | All expenses from all accounts |
| Accounts tab | Physical cash balance per account |
| Dashboard | Total balance, year-to-date income/expenses, monthly figures |
| I&E Statement (PDF) | Operational income (net of welfare) vs expenses |
| Welfare Fund Statement (PDF) | Collections, payouts, and fund liability |
| Financial Position (PDF) | Operational funds vs Welfare fund (restricted), total cash |

---

## 4. Dues & Assessment Rules

### Features
- Age-based dues rules (e.g. members over 65 pay reduced assessment)
- Per-year configuration — rules are locked once payments are recorded against them
- Per-member overrides for special cases
- Payment split rules defining how each category divides between operating and welfare

### Design Decisions
- **Rules lock automatically** once payments exist — prevents retroactive changes that would invalidate recorded transactions.
- **Overrides are per-member, per-year** — allows individual adjustments without changing the global rule.
- **Welfare split is category-specific** — e.g. "Assessment" splits 83%/17%, "Initiation Fee" splits 55%/45%.

---

## 5. Reports & Downloads

### Available Reports (PDF & CSV)
1. **Income & Expenditure Statement** — operational income vs expenses, net surplus/deficit
2. **Receipts & Payments Statement** — cash movements per account with opening/closing balances
3. **Welfare Fund Statement** — collections by member, payouts, liability balance
4. **Statement of Financial Position** — operational funds vs welfare (restricted) vs total cash
5. **Member Statement** — individual member's assessment, payments, and balance

### PDF Layout Design
- Proper accounting format with indentation, "Add:"/"Less:" labels
- Single underline for subtotals, double underline for final totals
- Organization letterhead with customizable header lines
- Configurable signatories for report endorsement
- Page numbers and generation date

---

## 6. Secretary Module (Events & Attendance)

### Features
- Create events with name, date, time, location, level, and type
- Configurable event types (admin can add/edit/delete)
- Event levels: Local Commandery, District/Regiment, Grand Commandery, Supreme Subordinate
- Mark attendance: Present / Permission / Absent
- Attendance dashboard with stats, upcoming events, and per-member scores
- "Add to Google Calendar" links for each event
- Optional Google Drive link for meeting minutes

### Design Decisions
- **Minutes are external** — written in Google Docs and linked. The app focuses on attendance tracking, not document authoring.
- **Event types are admin-configurable** — not hardcoded. Commanderies can add their own categories.
- **Attendance scoring** — percentage of events attended, color-coded (green ≥75%, amber ≥50%, red <50%).
- **No minutes PDF generation** — deliberately removed after testing showed it was too complex for the value it provided. Minutes are better handled manually.

---

## 7. SMS Notifications (mNotify)

### Features
- **Configuration via UI** — API key, sender ID, enable/disable, all managed in Organization Settings
- **Customizable message templates** with placeholders: `{name}`, `{event}`, `{date}`, `{time}`, `{location}`, `{amount}`, `{category}`, `{balance}`, `{year}`
- **Event reminders** — "Send SMS Reminder" button on event detail page → sends to all active members
- **Payment confirmations** — auto-sent when a receipt is posted for a member
- **Assessment reminders** — manual trigger from SMS page → sends only to members with outstanding balances
- **Test SMS** — send a single message to verify configuration
- **SMS log** — full history with delivery status, error messages, and stats

### Design Decisions
- **Config stored in database, not env files** — so the treasurer can update the API key without a deployment.
- **Templates are editable** — not hardcoded messages. The admin writes the message format.
- **Payment notifications are optional** — toggle in settings. Can be disabled to save SMS credits.
- **mNotify v2 API with legacy fallback** — tries the newer POST endpoint first, falls back to GET.
- **Phone normalization** — auto-converts 0244xxx to 233244xxx format for mNotify.

---

## 8. User Management & Access Control

### Roles
| Role | Access |
|------|--------|
| Admin | Full access to everything |
| President | Read access to all modules |
| Secretary | Members, events, attendance |
| Finance Secretary | Income, expenses, reports |
| Treasurer | Full financial access |
| Commander | Read access |
| Trustee | Financial oversight, audit reviews |
| Auditor | Read-only financial + audit trail |
| Executive | Limited access |
| Viewer | Read-only |

### Features
- Secure login with rate limiting (10 attempts per 15 minutes)
- Session-based authentication with httpOnly cookies
- CSRF protection on all forms
- Password hashing (bcrypt)
- Audit logging of all logins (successful and failed)

---

## 9. Governance & Audit

### Features
- **Immutable audit log** — every financial action, status change, login, and configuration change is logged with user, timestamp, before/after values
- **Trustee audit reviews** — structured checklist (income completeness, expense support, reconciliation, budget variance, audit trail, closing balances)
- **Auto audit** — automated checks for anomalies
- **Transaction flagging** — auditors can flag specific transactions with reasons
- **Investigation notes** — auditors can add notes to flagged transactions
- **Audit conclusion & recommendations** — formal completion workflow

### Design Decisions
- **Audit log is append-only** — no modification or deletion possible.
- **Structured checklist** — ensures trustees cover all required areas consistently.
- **Separation of concerns** — auditors can only view and flag; they cannot modify transactions.

---

## 10. Annual Budget

### Features
- Create income and expense budget lines per fiscal year
- Compare budget vs actual (variance analysis)
- Draft → Approved workflow
- Locked when fiscal year closes

---

## 11. Fiscal Year Management

### Features
- Open/close fiscal years
- Only one year active at a time
- Closing a year freezes all configurations for that year
- Transactions can only be entered within the active fiscal year
- Carry-forward of unpaid balances

### Design Decisions
- **Single active year** — prevents confusion about which period transactions belong to.
- **Date validation on entry** — the browser date picker constrains to the active year range, with server-side enforcement as backup.

---

## 12. Organization Settings

All configurable from the UI:
- Organization name, address, city, region, country
- Letterhead lines (appear on PDFs)
- Currency (GHS)
- Report signatories (up to 3)
- SMS configuration (API key, sender ID, templates)
- Commandery number and district

---

## 13. Technical Architecture

### Infrastructure
- **Application:** Node.js + Express running in Docker
- **Database:** PostgreSQL 15 in Docker
- **Proxy:** Nginx with Cloudflare
- **CI/CD:** GitHub Actions — auto-deploy on push to `feature/treasurio-overhaul` (dev) or `main` (prod)
- **Migration:** Idempotent `migrate.js` runs on every deploy — safe to run multiple times

### Key Design Patterns
- **Idempotent migrations** — all DDL uses `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`
- **Parameterized queries** — all SQL uses `$1, $2` placeholders (no SQL injection)
- **CSRF on all forms** — session-based token validation
- **Helmet CSP** — Content Security Policy blocks inline scripts
- **No inline JavaScript in templates** — all behavior via external `app.js`
- **EJS server-side rendering** — no client-side framework, fast page loads
- **Responsive design** — mobile-first with sidebar drawer on small screens

### File Structure
```
src/
├── server.js           — Express app, routes, middleware
├── dal.js              — Data Access Layer (PostgreSQL pool, query helpers)
├── services.js         — Business logic (report calculations, balances)
├── migrate.js          — Database schema migration
├── config.js           — Environment config loader
├── security.js         — Password hashing
├── pdfReports.js       — PDF generation helpers (PDFKit)
├── downloadableReports.js — CSV report generators
├── smsService.js       — mNotify SMS integration
├── secretaryRoutes.js  — Events & attendance routes
├── secretaryDomain.js  — Event validation logic
├── csvExport.js        — CSV export utilities
├── importMembers.js    — Bulk member import
├── memberDomain.js     — Member validation & status logic
├── configDomain.js     — Configuration validation
├── governanceDomain.js — Audit & budget validation
├── fiscalYearDomain.js — Fiscal year validation
├── viewHelpers.js      — Date/time formatting
├── public/
│   ├── app.css         — Full design system
│   └── app.js          — Client-side behavior (tables, modals, toasts)
└── views/
    ├── dashboard.ejs
    ├── finance_list.ejs
    ├── finance_welfare.ejs
    ├── organization.ejs
    ├── sms_log.ejs
    ├── secretary/
    │   ├── dashboard.ejs
    │   ├── events.ejs
    │   ├── event_form.ejs
    │   ├── event_detail.ejs
    │   ├── event_types.ejs
    │   └── attendance.ejs
    └── partials/
        ├── header.ejs
        ├── footer.ejs
        ├── sidebar.ejs
        └── finance-nav.ejs
```

---

## 14. Deployment

### Dev Environment
- Push to `feature/treasurio-overhaul` or `develop` → auto-deploys to dev VPS
- Database: `treasurio_dev`
- Port: 3100

### Production Environment
- Push to `main`/`master` → auto-deploys to production VPS
- Database: `treasurio_prod`
- Port: 3200

### Deploy Process (automated)
1. Pull latest code to VPS
2. Build Docker image
3. Run `node src/migrate.js` (creates/updates tables)
4. Start container
5. Health check at `/health`
6. SSL via Let's Encrypt (auto-provisioned)

---

## 15. Data Model Summary

### Core Tables
- `members` — membership register
- `transactions` — all financial movements (receipts, expenses, transfers, welfare payouts)
- `accounts` — bank/cash/momo/welfare fund accounts
- `fiscal_years` — open/closed periods
- `dues_rules` — assessment amounts by age band and year
- `payment_splits` — welfare split percentages per category
- `transaction_categories` — income/expense categories (configurable)
- `member_dues` — per-member per-year overrides

### Membership History
- `member_status_history` — status change audit trail
- `member_rank_history` — rank conferrals
- `member_position_history` — positions held
- `member_degrees` — degree conferrals (1–5)
- `member_transfers` — transfer origin records

### Secretary Module
- `meetings` — events (meetings, conventions, funerals, etc.)
- `meeting_attendance` — per-member attendance records
- `event_types` — configurable event type definitions

### SMS
- `sms_log` — all SMS messages sent with delivery status

### Governance
- `audit_log` — immutable action log
- `audit_reviews` — trustee audit sessions
- `audit_review_items` — checklist item outcomes
- `audit_flags` — flagged transactions
- `audit_transaction_notes` — investigation notes
- `annual_budgets` + `annual_budget_lines` — budget planning

### Configuration
- `organization_settings` — org profile, SMS config, signatories
- `commanderies` — commandery identity
- `rank_definitions` — configurable ranks
- `position_definitions` — configurable positions
