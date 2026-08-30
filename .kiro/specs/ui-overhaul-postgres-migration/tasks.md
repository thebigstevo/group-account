# Implementation Plan: UI Overhaul & PostgreSQL Migration

## Overview

This plan transforms "KSJI Accounts" into "TILC GroupLedger" across four tracks: (1) PostgreSQL database migration with a DAL abstraction, (2) CSS design system and client-side JS components, (3) EJS layout/view restructuring with sidebar navigation, and (4) Docker/VPS deployment infrastructure. Tasks are sequenced so that the data layer is built first, then UI components are layered on, views are refactored, and finally infrastructure and deployment artifacts are added.

## Tasks

- [x] 1. Project setup and configuration updates
  - [x] 1.1 Update package.json: rename to "treasurio", update description, add dependencies (pg, connect-pg-simple, fast-check as devDependency), remove better-sqlite3, add scripts for migrate and test:properties
    - Rename package `name` to `treasurio`
    - Update `description` to "Treasurio — Group & Club Financial Management"
    - Add `pg`, `connect-pg-simple` to dependencies
    - Add `fast-check`, `supertest` to devDependencies
    - Remove `better-sqlite3` from dependencies
    - Add scripts: `"migrate": "node src/migrate.js"`, `"test:properties": "jest --testPathPattern=properties --detectOpenHandles"`
    - _Requirements: 16.4, 9.1_

  - [x] 1.2 Extend src/config.js with PostgreSQL connection vars and branding env vars
    - Add `databaseUrl`, `pgHost`, `pgPort`, `pgDatabase`, `pgUser`, `pgPassword`, `pgPoolSize` (clamped 1–100, default 10)
    - Add `groupName` (default "My Group"), `groupCurrency` (default "GHS")
    - Remove `dbPath`
    - Validate at startup: if neither DATABASE_URL nor PGHOST+PGDATABASE+PGUSER set, terminate with non-zero exit code and error log
    - _Requirements: 9.1, 9.2, 9.3, 16.2, 16.3_

  - [x]* 1.3 Write property tests for config module
    - **Property 13: Pool Size Clamping** — verify PG_POOL_SIZE clamped to [1, 100] for any input
    - **Property 14: Database URL Precedence** — verify DATABASE_URL takes precedence over individual vars
    - **Property 25: Branding Configuration Rendering** — verify GROUP_NAME/GROUP_CURRENCY defaults
    - **Validates: Requirements 9.1, 9.2, 16.2, 16.3**

- [x] 2. Data Access Layer (DAL)
  - [x] 2.1 Create src/dal.js with pg Pool, query/queryOne/run/transaction/shutdown/audit functions
    - Initialize pg Pool with config (connectionString or individual vars, pool size, 5s connection timeout, 30s idle timeout)
    - Implement retry logic: 3 retries with exponential backoff (1s, 2s, 4s) on connection errors
    - `query(sql, params)` → returns `result.rows` (array)
    - `queryOne(sql, params)` → returns `result.rows[0] || null`
    - `run(sql, params)` → returns `{ rowCount: result.rowCount, rows: result.rows }`
    - `transaction(callback)` → acquires client, BEGIN, calls callback(client), COMMIT on success / ROLLBACK+rethrow on error, always releases client
    - `shutdown()` → calls `pool.end()`
    - `audit(userId, action, entity, entityId, details, options)` → INSERT into audit_log with parameterized query
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 9.1, 9.8, 9.10_

  - [x]* 2.2 Write property tests for DAL module
    - **Property 16: DAL Query Interface Contract** — verify query returns array, queryOne returns object|null, run returns {rowCount, rows}
    - **Property 17: Transaction Commit and Rollback** — verify commit on success, rollback+rethrow on error, client always released
    - **Validates: Requirements 11.1, 11.2**

- [x] 3. Migration script and session store
  - [x] 3.1 Create src/migrate.js — idempotent PostgreSQL schema creation
    - CREATE TABLE IF NOT EXISTS for all 11 tables + sessions table
    - Map types: SERIAL PRIMARY KEY, VARCHAR(255), TEXT, NUMERIC(12,2), BOOLEAN, TIMESTAMP DEFAULT NOW()
    - Preserve all CHECK, UNIQUE, and FOREIGN KEY constraints
    - CREATE INDEX IF NOT EXISTS for all 6 existing indexes + idx_sessions_expire
    - Seed default accounts and transaction categories only when tables are empty (SELECT COUNT check)
    - _Requirements: 9.4, 9.5, 9.6, 9.7, 9.9, 13.2_

  - [x]* 3.2 Write property tests for migration script idempotence
    - **Property 15: Migration Script Idempotence** — verify running N times produces no errors, no duplicate data
    - **Validates: Requirements 9.5, 9.7**

  - [x] 3.3 Replace session store: remove src/sessionStore.js, configure connect-pg-simple in server.js
    - Remove SQLiteSessionStore import and usage
    - Configure `connect-pg-simple` with DAL pool, tableName 'sessions', pruneSessionInterval 3600
    - Handle session DB errors → HTTP 503 with error page
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [x] 4. Checkpoint - Ensure data layer works
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Refactor services.js for PostgreSQL dialect
  - [x] 5.1 Convert services.js from synchronous better-sqlite3 to async DAL calls
    - Replace all `db.prepare(sql).get(params)` with `await dal.queryOne(sql, params)`
    - Replace all `db.prepare(sql).all(params)` with `await dal.query(sql, params)`
    - Convert `?` placeholders to `$1, $2, ...` numbered placeholders
    - Replace `strftime('%Y', tx_date)` with `SUBSTRING(tx_date FROM 1 FOR 4)` (since tx_date is VARCHAR(10))
    - Make all exported functions async
    - Update `dateClause` helper to use `$N` placeholders with a param index tracker
    - _Requirements: 9.8, 9.9, 11.1_

  - [x]* 5.2 Write unit tests for refactored services.js
    - Test calculateWelfareComponent, arrearsReport, memberDue with mocked DAL
    - Test dateClause produces correct parameterized SQL
    - _Requirements: 9.8, 9.9_

- [x] 6. Refactor server.js to async/await with DAL
  - [x] 6.1 Convert all route handlers in server.js to async, replace db calls with DAL
    - Convert every route handler to `async (req, res)` or `async (req, res, next)`
    - Replace `db.prepare(...).get/all/run(...)` with `await dal.queryOne/query/run(...)`
    - Replace `?` placeholders with `$1, $2, ...`
    - Use `RETURNING id` on INSERT statements to get inserted IDs (replaces `lastInsertRowid`)
    - Replace `result.changes` with `result.rowCount`
    - Replace `db.transaction(() => {...})` blocks with `await dal.transaction(async (client) => {...})`
    - Remove `const { db, audit } = require('./db')`, use `const dal = require('./dal')`
    - Add `dal.audit(...)` calls replacing the old `audit(...)` function
    - Add graceful shutdown handler: on SIGTERM/SIGINT call `dal.shutdown()`
    - _Requirements: 9.8, 9.9, 11.1, 11.2, 11.4_

  - [x] 6.2 Add health endpoint to server.js
    - `GET /health` → `await dal.queryOne('SELECT 1')` → `{ status: 'ok', database: 'connected' }` (200) or `{ status: 'error', database: 'unreachable' }` (503)
    - Place before rate limiter and auth middleware
    - _Requirements: 17.8_

  - [x] 6.3 Update res.locals middleware for branding
    - Read `groupName` and `groupCurrency` from config
    - Set `res.locals.title = 'Treasurio'`
    - Set `res.locals.groupName` and `res.locals.groupCurrency`
    - Update `formatMoney` to use configured currency code
    - _Requirements: 16.1, 16.2, 16.3_

- [x] 7. Checkpoint - Ensure server starts and routes work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Design system CSS
  - [x] 8.1 Rewrite src/public/app.css with design token system
    - Define `:root` CSS custom properties: primary scale (50–900), neutral scale (50–900), success/warning/danger (3 shades each)
    - Spacing scale: `--space-1` (4px) through `--space-8` (32px)
    - Border radius: `--radius-sm` (4px), `--radius-md` (8px), `--radius-lg` (12px)
    - Typography: system font stack, h1 (30px/1.875rem), h2 (24px/1.5rem), h3 (20px/1.25rem), h4 (16px/1rem), body (16px/1rem), caption (12px/0.75rem), label (13px/0.8125rem)
    - Transitions: `--transition-hover` (150ms), `--transition-focus` (100ms), `--transition-panel` (250ms)
    - Focus: `--focus-ring-width` (2px), `--focus-ring-offset` (3px), `--focus-ring-color` (primary)
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 8.2 Add component styles to app.css
    - `.sidebar` — 240px fixed left panel
    - `.data-table` — sortable, paginated table with sticky first column
    - `.form-group`, `.fieldset` — grouped form fields with divider lines
    - `.toast`, `.toast-container` — notification overlay (top-right, 16px offset)
    - `.modal`, `.modal-backdrop` — confirmation dialog
    - `.metric-card` — dashboard summary card
    - `.badge` — status/role indicators
    - `.btn`, `.btn--primary`, `.btn--danger`, `.btn--secondary` — button variants (44px min touch target on mobile)
    - `.skip-nav` — skip navigation link
    - `@media print` styles: hide sidebar, toast, actions; expand tables; white background, black text; print header
    - `@media (max-width: 768px)` — single column, hamburger drawer, increased touch targets
    - _Requirements: 1.1, 1.4, 2.1, 4.6, 5.1, 6.1, 7.3, 8.1, 8.2, 8.3, 14.1, 14.2, 14.3, 14.4_

  - [x]* 8.3 Write property test for contrast ratio compliance
    - **Property 22: Contrast Ratio Compliance** — verify all color pairs meet WCAG AA thresholds
    - **Validates: Requirements 15.3**

- [x] 9. Client-side JavaScript components
  - [x] 9.1 Implement DataTable component in src/public/app.js
    - `init(tableEl)` — attach sort, filter, pagination handlers to table
    - `sort(column, direction)` — sort rows, toggle asc/desc, display arrow indicator on active column only
    - `filter(term)` — case-insensitive substring match across all displayed columns, 300ms debounce, reset to page 1
    - `paginate(page, pageSize)` — slice rows for current page, render page controls (prev, next, up to 5 page buttons), page size selector (10/25/50)
    - Sort while filter active preserves filter (Property 6)
    - Empty state message when no matching rows
    - Sticky first column via CSS (works at all viewport widths)
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.7_

  - [x] 9.2 Implement Toast component in src/public/app.js
    - `show(message, type, duration)` — create toast in top-right corner, auto-dismiss after 4s for success
    - Error toasts remain until manually dismissed
    - Close button with aria-label="Dismiss notification", keyboard accessible (Enter/Space)
    - Max 3 visible simultaneously, stack vertically, oldest auto-dismissed on overflow
    - `role="status"` for success, `role="alert"` for danger
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 9.3 Implement Modal component in src/public/app.js
    - `open(options)` — render modal with title, body, onConfirm callback
    - Focus trap: tab cycles within modal only
    - Close on Escape, backdrop click, or Cancel — does NOT execute destructive action
    - Confirm button executes action then closes
    - `role="alertdialog"`, `aria-labelledby`, `aria-describedby`
    - Return focus to triggering element on close
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 9.4 Implement Sidebar toggle component in src/public/app.js
    - `toggle()` — open/close mobile drawer with backdrop (40%+ opacity)
    - `setActive(path)` — highlight active link + parent group (left-border accent ≥3px)
    - Close on backdrop tap, link selection, or Escape key
    - _Requirements: 2.2, 2.3, 2.6_

  - [x] 9.5 Implement form validation in src/public/app.js
    - Inline validation on blur (within 200ms): required non-empty, numeric 0–999999999.99, valid date
    - Disable submit when any required field empty or has error; re-disable on new errors
    - Date constrained to active fiscal year range
    - Helper text below amount fields
    - _Requirements: 5.3, 5.4, 5.7, 5.8_

  - [x]* 9.6 Write property tests for client-side components
    - **Property 3: Data Table Sort Correctness** — sort produces correct ordering for any array
    - **Property 4: Data Table Pagination Slice** — paginate returns correct slice for any N, P, S
    - **Property 5: Data Table Search Filter** — filter returns only matching rows
    - **Property 6: Sort Preserves Active Filter** — sort after filter preserves both
    - **Property 7: Form Validation State Correctness** — validation produces correct errors for any input
    - **Property 9: Date Constrained to Fiscal Year** — dates outside fiscal year are rejected
    - **Property 10: Toast Maximum Visible Limit** — max 3 visible at once
    - **Property 11: Toast ARIA Role Assignment** — success→status, danger→alert
    - **Property 12: Modal Close Safety** — close methods never execute destructive action
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.7, 5.3, 5.4, 5.7, 6.4, 6.5, 7.4**

- [x] 10. Checkpoint - Ensure CSS and JS components work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. EJS layout and partials
  - [x] 11.1 Create src/views/layout.ejs with sidebar, skip-nav, toast container, and main content area
    - Skip navigation link as first focusable element
    - Include sidebar partial (left panel on desktop, drawer on mobile)
    - Include topbar-mobile partial (hamburger + brand mark for ≤768px)
    - Main content area with `<main>` landmark
    - Toast container region
    - Modal shell partial
    - HTML title: `<%= title %> – Treasurio`
    - Semantic landmarks: `<nav>`, `<main>`, `<header>`, `<footer>`
    - _Requirements: 8.1, 8.3, 15.1, 15.2, 15.6_

  - [x] 11.2 Create src/views/partials/sidebar.ejs
    - Brand header: "Treasurio" text logo + optional /public/logo.png
    - Navigation groups: Operations (Dashboard, Transactions, Members), Reporting (Reports, Reconciliation, Downloads), Administration (Config, Dues, Fiscal Years, Users, Audit)
    - Role-based visibility: hide Administration group for viewer; show only Audit for auditor; full access for admin/finance_secretary/treasurer
    - Active link highlighting with left-border accent (≥3px)
    - User info at bottom: name (truncated 20 chars with ellipsis), role badge, sign-out action
    - `aria-label="Main navigation"` on nav element
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 16.1, 16.5_

  - [x] 11.3 Create src/views/partials/topbar-mobile.ejs, toast-container.ejs, modal.ejs, print-header.ejs, data-table.ejs, pagination.ejs
    - topbar-mobile: hamburger icon + "Treasurio" brand, ≤56px height
    - toast-container: fixed top-right region for toast notifications with aria-live
    - modal: reusable modal shell with role="alertdialog"
    - print-header: group name, view title, print date (DD/MM/YYYY)
    - data-table: reusable table component with search input, sort indicators, pagination
    - pagination: prev/next buttons, page numbers (max 5), page size selector
    - _Requirements: 2.3, 6.1, 7.6, 14.3, 4.1, 4.2, 8.3_

  - [x]* 11.4 Write property tests for navigation and accessibility
    - **Property 1: Sidebar Active Link Determination** — exactly one link highlighted per route
    - **Property 2: Role-Based Navigation Visibility** — correct links shown per role
    - **Property 23: Form Label Association** — every input has a matching label for/id pair
    - **Property 24: Document Title Format** — title follows "ViewName – Treasurio" format
    - **Validates: Requirements 2.2, 2.5, 15.4, 15.6**

- [x] 12. Dashboard redesign
  - [x] 12.1 Rewrite src/views/dashboard.ejs with metric cards, work queue, recent transactions, quick actions
    - Metric cards: each active account balance, total income, total expenses, welfare liability, spendable estimate
    - Work queue card list: uncleared tx count → /transactions, members with arrears → /reports, active member count → /members, latest reconciliation date → /reconciliation
    - Recent transactions: Data_Table limited to 10, columns: Date, Type badge, Member, Account, Category, Amount
    - Quick-action buttons: Record Receipt, Record Expense, Reconcile, View Reports (between heading and metrics)
    - Responsive grid: 2-column on >768px, single-column on ≤768px
    - Empty state for no transactions
    - Error state for data load failure
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 12.2 Update dashboard route handler in server.js for new data requirements
    - Ensure all summary metrics are passed: account balances, total income, total expenses, welfare liability, spendable estimate
    - Pass work queue data: unreconciled count, arrears count, active member count, latest reconciliation date
    - Pass recent 10 transactions (sorted by tx_date DESC, id DESC)
    - Handle errors gracefully (pass error flag if DB query fails)
    - _Requirements: 3.1, 3.2, 3.3, 3.7_

- [x] 13. View templates refactored
  - [x] 13.1 Refactor all existing view templates to use new layout.ejs and design system components
    - Wrap each view in layout.ejs (remove individual header/footer includes)
    - Replace raw tables with data-table partial usage
    - Add fieldset groupings and inline validation attributes to all forms
    - Add required field indicators (`*`) and "* Required" legend
    - Add modal confirmations for transaction reversal and fiscal year closure
    - Set page-specific document title via `<% locals.title = 'ViewName' %>`
    - Ensure all form inputs have associated labels (for/id pairing)
    - Add aria-live regions for dynamic content updates
    - Apply responsive classes for mobile layout
    - _Requirements: 4.4, 5.1, 5.2, 5.6, 7.1, 7.2, 8.1, 8.2, 15.1, 15.2, 15.4, 15.5, 15.6_

  - [x] 13.2 Update form submission handlers in server.js to preserve values on error
    - On server-side validation failure, re-render form with `req.body` values and error summary
    - Pass error messages as array for rendering at top of form
    - Ensure toast notification triggers on successful submissions (via flash/session message)
    - _Requirements: 5.5, 5.6_

- [x] 14. Checkpoint - Ensure full UI works end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Docker and deployment infrastructure
  - [x] 15.1 Rewrite docker-compose.yml with PostgreSQL service
    - Remove SQLite volume (accounts_data) and DB_PATH env var
    - Add postgres service: postgres:16-alpine, pgdata volume at /var/lib/postgresql/data
    - Postgres env: POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD with variable substitution + fallback
    - Postgres healthcheck: pg_isready, 5s interval, 5s timeout, 5 retries, 10s start_period
    - App service: depends_on postgres condition: service_healthy
    - App env: PGHOST=postgres, PGPORT=5432, PGDATABASE, PGUSER, PGPASSWORD, SESSION_SECRET, N8N_API_TOKEN, GROUP_NAME, GROUP_CURRENCY
    - App port: "127.0.0.1:${APP_PORT:-3100}:3000"
    - Network: treasurio-net (isolated)
    - Both services: restart: unless-stopped
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 17.2, 17.4_

  - [x] 15.2 Create multi-stage Dockerfile
    - Stage 1 (builder): node:22-alpine, copy package*.json, npm ci
    - Stage 2 (production): node:22-alpine, copy node_modules from builder, copy src/, set NODE_ENV=production, USER node, EXPOSE 3000, CMD runs migrate then starts server
    - _Requirements: 17.9_

  - [x] 15.3 Create apps/treasurio/ deployment directory with scripts
    - apps/treasurio/docker-compose.yml (copy of root or symlink reference)
    - apps/treasurio/.env.example
    - apps/treasurio/deploy-treasurio.sh — interactive prompt for domain/port, generate .env, output Nginx config block
    - apps/treasurio/backup.sh — pg_dump → backups/treasurio_YYYYMMDD_HHMMSS.sql.gz, retain last 7
    - apps/treasurio/restore.sh — accept backup path arg, drop/recreate DB, restore from .sql.gz
    - apps/treasurio/remove-treasurio.sh — stop containers, remove network, --purge deletes pgdata volume
    - apps/treasurio/README.md — deployment docs, env vars, backup/restore, Nginx snippet
    - _Requirements: 17.1, 17.3, 17.5, 17.6, 17.7, 17.10_

- [x] 16. SQLite to PostgreSQL data migration tool
  - [x] 16.1 Create src/tools/migrate-sqlite-to-pg.js
    - Read SQLITE_PATH env var, validate file exists and is valid SQLite
    - Check target PG tables are empty (abort if not)
    - Migrate in dependency order: users, members, accounts, fiscal_years, dues_rules, payment_splits, transaction_categories, member_dues, transactions, reconciliations, audit_log
    - Type conversions: TEXT dates → as-is, REAL → NUMERIC(12,2), INTEGER booleans (0/1) → true/false
    - Execute within single PG transaction (rollback all on any failure)
    - Preserve primary key values
    - Reset SERIAL sequences to MAX(id) + 1 (or 1 for empty tables)
    - Log per-table progress: table name, rows migrated, duration
    - Verify row counts match source; report discrepancies
    - Exit 0 on success, non-zero on any failure
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

  - [x]* 16.2 Write property tests for data migration tool
    - **Property 18: Data Migration Type Preservation** — types converted correctly for any row
    - **Property 19: Sequence Reset Correctness** — sequences set to MAX(id)+1 or 1
    - **Property 20: Migration Transactional Rollback** — error in any table rolls back all
    - **Property 21: Migration Row Count Verification** — row counts match source
    - **Validates: Requirements 12.1, 12.3, 12.4, 12.8**

- [x] 17. Finalization and cleanup
  - [x] 17.1 Update .env.example with all new environment variables
    - Add: DATABASE_URL, PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PG_POOL_SIZE, GROUP_NAME, GROUP_CURRENCY, APP_PORT, DOMAIN
    - Remove: DB_PATH
    - _Requirements: 9.2, 16.2, 16.3_

  - [x] 17.2 Remove deprecated files: src/db.js, src/sessionStore.js
    - Delete src/db.js (replaced by src/dal.js)
    - Delete src/sessionStore.js (replaced by connect-pg-simple)
    - Update any remaining imports across the codebase
    - _Requirements: 9.1, 13.1_

  - [x] 17.3 Update root README.md for Treasurio branding and generic group/club description
    - Rebrand to "Treasurio — Group & Club Financial Management"
    - Remove KSJI-specific references
    - Document new environment variables and PostgreSQL setup
    - _Requirements: 16.6_

  - [x]* 17.4 Write integration tests
    - Test /health endpoint with DB up (200) and DB down (503)
    - Test session store with connect-pg-simple against real PostgreSQL
    - Test migration script runs idempotently against test database
    - Test key route handlers (login, transactions, members) with supertest
    - _Requirements: 9.10, 13.4, 17.8_

- [x] 18. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each major phase
- Property tests validate universal correctness properties defined in the design document
- Unit tests validate specific examples and edge cases
- The DAL is built first because all subsequent refactoring depends on it
- View refactoring (task 13) should be done after the layout/partials (task 11) and components (tasks 8–9) are in place
- The SQLite→PG migration tool (task 16) can be developed in parallel with the UI work since it's independent

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "8.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "8.2"] },
    { "id": 3, "tasks": ["3.2", "3.3", "8.3", "9.1", "9.2", "9.3", "9.4", "9.5"] },
    { "id": 4, "tasks": ["5.1", "9.6"] },
    { "id": 5, "tasks": ["5.2", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3"] },
    { "id": 7, "tasks": ["11.1", "11.2", "11.3"] },
    { "id": 8, "tasks": ["11.4", "12.1", "12.2"] },
    { "id": 9, "tasks": ["13.1", "13.2"] },
    { "id": 10, "tasks": ["15.1", "15.2", "15.3", "16.1"] },
    { "id": 11, "tasks": ["16.2", "17.1", "17.2", "17.3"] },
    { "id": 12, "tasks": ["17.4"] }
  ]
}
```
