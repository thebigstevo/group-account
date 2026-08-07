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


---

## 16. Nuances & Edge Cases

### Financial Calculations

**Why "Income this year" differs from "Total on income page":**
- The income page shows the raw `SUM(amount)` of posted operational receipts (excluding welfare fund account). This is what members actually handed over.
- The "Income this year" on the overview uses `SUM(amount - welfare_component)` which deducts welfare portions embedded in split transactions. This is the operational income figure that matches the I&E report.
- Both exclude receipts deposited directly into the welfare fund account.
- **Rule of thumb:** If a number appears on a formal report (I&E, Financial Position), the dashboard matches that report.

**Welfare component vs welfare fund account:**
- `welfare_component` is a field on each transaction that records how much of that receipt was earmarked for welfare (via the auto-split mechanism).
- The Welfare Fund account (id 4, `is_welfare_fund = true`) is the physical bank/cash account where welfare money lives.
- A receipt can have `welfare_component > 0` AND be in a regular account (if the split creates two transactions: one operating portion to Cash, one welfare portion to Welfare Fund).
- A receipt can be in the welfare fund account with `welfare_component = 0` (a direct deposit without using the split mechanism, like lump-sum welfare payments from external sources).
- Both paths contribute to the welfare fund balance. The system queries both conditions when calculating welfare collections.

**Split transactions (split_group_id):**
- When a receipt auto-splits, two transaction rows are created and linked via `split_group_id`.
- Row 1: Operating portion → regular account, `welfare_component = 0`
- Row 2: Welfare portion → welfare fund account, `welfare_component = full amount`
- The split_group_id equals the ID of the first row, linking them as a pair.
- Editing one split half recalculates the other.

**Opening arrears carry-forward:**
- Each member has an `opening_arrears` field representing debt carried from before the system was deployed.
- When viewing a member's balance: `opening_arrears + assessment_due - assessment_paid = outstanding balance`
- This is a static value set during member import or manual entry — it doesn't auto-update at year-end (year-end carry-forward is not yet implemented).

### Member Assessments

**How dues are calculated:**
1. System looks at `dues_rules` for the active fiscal year.
2. If the member has an override in `member_dues`, that takes precedence.
3. Otherwise, the member's age (based on DOB vs current year) is matched against age band rules.
4. The matching rule provides `annual_assessment` (total owed) and `welfare_portion` (what split goes to welfare).
5. If no rule matches (no DOB, no override), assessment due is 0.

**Batch entry behavior:**
- All entries share the same date, category, and receiving account.
- Each member gets their own individual transaction record.
- The welfare split runs independently per member (in case different members have different split rules).
- Members with blank or zero amounts are silently skipped — no error.

**Assessment vs other income categories:**
- Categories have a `purpose` field: `assessment`, `welfare_income`, `welfare_payout`, or `standard`.
- Only receipts with `purpose = 'assessment'` count toward a member's assessment balance.
- Other receipts (donations, initiation fees, levies) are tracked but don't reduce the member's "owing" amount.
- The member statement distinguishes: "Assessment payments" vs "Other payments (not against assessment)".

### Transaction Lifecycle

**Recording → Posting → Reversal:**
- Transactions are created with `status = 'posted'` immediately (there's no pending/confirmation workflow in the current implementation).
- To undo a transaction, you "reverse" it — this sets `status = 'reversed'` on the original and creates a new offsetting record.
- Reversed transactions remain in the database forever — they're excluded from all calculations by `WHERE status = 'posted'`.
- The income/expense pages show reversed transactions with a "Reversed" badge so you can see the history.

**Edit vs Reverse:**
- Editing a posted transaction updates it in-place (date, amount, member, category, reference).
- If the transaction was split (welfare auto-split), editing one half recalculates the other.
- Reversing creates a permanent record that the original was voided — useful for audit trail when the original was wrong and shouldn't have existed.

**Fiscal year enforcement:**
- The system validates that any transaction date falls within the active fiscal year's range.
- The `<input type="date">` field has `min` and `max` attributes constraining to the year.
- Server-side validation rejects dates outside the range even if the browser constraints are bypassed.
- If no fiscal year is active, non-admin users see a "setup required" page and cannot access the system.

### Reconciliation

**How reconciliation works:**
- Treasurer enters the statement balance from the bank for a period.
- System calculates what the balance should be based on recorded transactions.
- If they match: transactions in that period are marked `reconciled = true`.
- If they don't match: a difference is recorded but transactions remain unreconciled.
- The dashboard shows "Unreconciled items" count as a work item.

### Account Balances

**Balance calculation formula:**
```
Account balance = opening_balance
  + SUM(receipts into this account)
  + SUM(transfers into this account)
  - SUM(expenses from this account)
  - SUM(welfare_payouts from this account)
  - SUM(transfers out of this account)
```
All filtered by `status = 'posted'`.

**Welfare Fund account balance** includes:
- Direct deposits (someone pays welfare directly)
- Welfare split portions (auto-split from assessments)
- Minus any welfare payouts made from this account

### Event Attendance Scoring

**Calculation:** `(events attended as 'present') / (total events where attendance was marked for that member) × 100`

- If attendance hasn't been marked for an event, that event doesn't count against anyone.
- Only active members are scored.
- Score is year-based — reset implicitly each year as new events are created.
- Color coding: ≥75% green, ≥50% amber, <50% red.

### SMS Delivery

**Phone normalization rules:**
- `0244123456` → `233244123456` (strip leading 0, prepend 233)
- `+233244123456` → `233244123456` (strip +)
- `233244123456` → `233244123456` (already correct)
- `244123456` → `233244123456` (prepend 233 for 9-digit numbers)

**Error codes from mNotify:**
- `1000` = success (legacy API)
- `2000` = success (v2 API)
- `1004` = invalid API key
- `1003` = insufficient balance
- `1005` = invalid phone number

**SMS is fire-and-forget for payment confirmations:** If SMS delivery fails, the payment still records successfully. SMS errors are logged but don't block the financial operation.

---

## 17. Design Philosophy & Trade-offs

### Why Server-Side Rendering (not SPA)
- **Target users** are treasurers and secretaries on mobile phones with variable connectivity.
- SSR pages load fast on slow networks — no large JS bundle to download.
- No API versioning headaches — the view and data are always in sync.
- Simpler deployment — one container, one process.
- Trade-off: No real-time updates, full page reload on actions.

### Why PostgreSQL (not SQLite/MySQL)
- Needed transactional integrity for financial operations.
- Advisory locks for migration safety.
- Array types for flexible queries.
- `ON CONFLICT` for upserts (member dues overrides, event types).
- Strong type system with CHECK constraints.

### Why No Client-Side Framework
- Helmet CSP blocks inline scripts — rules out most JS frameworks that inject inline handlers.
- EJS is simple, fast, and the templates are readable by anyone.
- The `app.js` file handles progressive enhancement: sorting, pagination, modals, toasts.
- Trade-off: More complex UI patterns (drag-drop, real-time) aren't feasible without relaxing CSP.

### Why Welfare is Separated from Income
- KSJI welfare is a trust fund — money collected from members for their collective benefit.
- If the commandery reports welfare as income, the financial position looks inflated.
- The Grand Commandery requires separate welfare reporting.
- By separating it at the data level (not just the report level), it's impossible to accidentally spend welfare money on operations without creating a visible withdrawal from the welfare account.

### Why No Pending/Approval Workflow for Transactions
- In practice, the treasurer records payments at the time of collection. There's no separate verification step.
- Adding a pending state would double the work without adding value for a small commandery.
- The audit trail (who recorded it, when) serves as accountability.
- If a mistake is made, the reversal mechanism provides correction without destroying history.

### Why Minutes Were Removed from the System
- Attempted implementation showed that the formatting requirements were too specific to automate well.
- Minutes involve narrative text, lettered sub-sections, and organizational conventions that don't map cleanly to form fields.
- The secretary is faster writing in Google Docs and pasting a link.
- The system's value add is in attendance tracking and scoring — not document authoring.

### Why Event Types Are Configurable (not hardcoded)
- Different commanderies have different activities.
- The initial hardcoded list (meeting, offertory, convention, social, funeral, community_service, other) was a starting point.
- Admin can add types like "Drill Competition", "Parish Harvest", "Degree Conferral" without code changes.
- Soft-delete (deactivate) ensures historical events with that type aren't broken.

### Why SMS Config is in the Database (not env vars)
- The treasurer changes every 1-2 years. New treasurer needs to update the API key.
- Env vars require server access or a code deployment.
- Database config means the admin updates it via the Organization Settings UI — no technical skills needed.
- Trade-off: API key is stored in the database (encrypted at rest by PostgreSQL, but visible to anyone with DB access). Acceptable for this use case.

---

## 18. Known Limitations & Future Considerations

### Current Limitations
1. **No mobile app** — web only, though responsive design works on phones.
2. **No offline mode** — requires internet connectivity.
3. **Single commandery per deployment** — multi-commandery would need schema changes.
4. **No automated SMS reminders** — event reminders and assessment reminders are manual button clicks, not scheduled.
5. **No payment gateway** — all payments are recorded manually by the treasurer after physical collection.
6. **No receipt printing from app** — receipts are implied by the transaction record and member statement PDF.
7. **Year-end carry-forward is manual** — closing a fiscal year doesn't auto-create opening balances for the next year.
8. **SMS provider is Ghana-specific (mNotify)** — would need abstraction for other countries.

### Potential Future Features
- Scheduled SMS reminders (cron job sending reminders X days before events)
- Google Calendar API sync (read/write events)
- Member self-service portal (view own statement, update contact info)
- Online payments (Paystack/MTN MoMo integration)
- Year-end close wizard (auto carry-forward balances)
- Multi-commandery support (shared database, tenant isolation)
- Budget vs actual variance alerts
- Export to Excel (currently CSV only)

---

## 19. Operational Procedures

### Monthly Treasurer Workflow
1. Collect payments at meeting
2. Go to **Income → Batch Entry** → enter all amounts → submit
3. Record any expenses (transport, offertory, etc.) via **Expenses → Record Expense**
4. Check the **Dashboard** — verify totals look reasonable
5. Send assessment reminders to members with arrears: **SMS → Send Assessment Reminders**

### Monthly Secretary Workflow
1. Before meeting: Create event in **Events → New Event**
2. Send reminder: Open event → **Send SMS Reminder**
3. At meeting: Mark attendance → **Mark Attendance**
4. After meeting: Write minutes in Google Docs, paste link in event edit

### Year-End Workflow
1. Ensure all transactions for the year are entered
2. Run reconciliation for each account
3. Download all reports (I&E, Receipts & Payments, Welfare Fund, Financial Position)
4. Complete trustee audit review
5. Close the fiscal year in **Fiscal Years**
6. Open the new fiscal year
7. Set new dues rules for the incoming year

### New Member Onboarding
1. **Members → Add Member** — enter all details
2. Set opening arrears if they owe from a previous period
3. Their assessment is auto-calculated based on age and dues rules
4. They appear in batch entry and welfare tracking immediately

### Data Backup
- Admin can download a full database backup via **Admin → Download Backup**
- The VPS also has automated daily backups via cron (configured in deploy scripts)
