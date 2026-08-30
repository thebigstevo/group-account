# Repository Assessment and Risks

## Current state before Phase 1

- Stack: Node.js/Express, EJS, PostgreSQL (`pg`), database sessions, Docker Compose, Nginx/Certbot deployment through GitHub Actions.
- Shape: a compact server-rendered monolith with route-level role checks and a small shared DAL; appropriate for incremental modularization rather than a rewrite.
- Membership: one basic `members` table already referenced by transactions, dues, statements, reminders, imports, and reports. This is the correct authoritative record to extend.
- Finance: meaningful production behavior already exists for accounts, transactions, welfare allocation, dues, reversals, reconciliation, fiscal years, exports, and downloadable reports.
- Security: password hashing, CSRF checks, Helmet, sessions, rate limiting, and basic audit events exist. Authorization was previously five coarse roles and is duplicated in route lists/templates.
- UI: a responsive design system and mobile navigation exist, but the old member workflow mixed membership status and opening arrears into one general-purpose form.
- Delivery: dev/prod workflows already build, migrate, health-check, and configure Nginx/SSL on the VPS.

## Key risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Existing finance relationships break | Critical | Extend `members` in place; preserve IDs and foreign keys; no duplicate directory. |
| Duplicate names are treated as identity | High | Drop unique-name assumption; generate membership numbers; make imports flag ambiguous matches. |
| Legacy `inactive` status has no exact corrected equivalent | Medium | Map to `resigned`, seed history, and require deployment review of affected records. |
| Role expansion accidentally grants finance or emergency access | High | Server-side named policy functions, narrow emergency allowlist, explicit permission matrix and tests. |
| Status and audit records diverge | High | Update status, insert history, and write audit in one transaction. |
| Re-running migration creates duplicate history/numbers | High | Additive `IF NOT EXISTS`, conditional backfill, unique index, and initial-history existence check. |
| Future rank model repeats the Officer ambiguity | High | Lock corrected ranks in requirements; derive Officer from Lieutenant+; never offer it as a stored rank. |
| Letter templates enable code execution/data leakage | Critical | Future allowlisted placeholder parser only; reject unknown paths; immutable issued snapshots. |
| Mobile forms become dense | Medium | Split profile, status, and emergency workflows; use responsive one-column layouts and horizontal table containment. |
| Rollback after new statuses are written | High | Back up first; deploy migration and app together; rollback app only with writes paused and status compatibility reviewed. |

## Recommended deployment gate

Take a database backup, count legacy statuses and duplicate names, run migration in dev, verify member/transaction/dues counts and foreign keys, exercise each role, then approve production. Do not deploy Phase 2 until Phase 1 data cleanup and permission review are signed off.
