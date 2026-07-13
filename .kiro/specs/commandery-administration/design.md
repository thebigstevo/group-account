# Design

## Current architecture and approach

The application is a Node.js/Express monolith using EJS, PostgreSQL through a small `pg` data-access layer, database-backed sessions, CSRF protection, role middleware, and an append-oriented audit table. Finance routes and reports reference `members.id`, so Phase 1 extends `members` in place.

The Phase 1 design adds:

- `commanderies`: tenant/organizational identity and membership-number prefix.
- Expanded `members`: structured identity/contact/admission fields plus commandery and permanent number.
- `member_status_history`: append-only effective-dated status events.
- `member_emergency_contacts`: commandery-scoped restricted contact records.
- Expanded `users.role` constraint and richer `audit_log` columns.
- A database trigger backed by a sequence for concurrency-safe membership numbers.
- `memberDomain.js` for pure normalization, validation, status, and authorization rules.

General profile edits cannot update status. Status changes run in one PostgreSQL transaction with the history row and audit event. Existing legacy `inactive` members are mapped to `resigned` during migration and receive an initial history row; this mapping must be reviewed during deployment validation.

## Authorization boundary

Routes enforce authorization server-side; hidden buttons are convenience only. Membership administration is limited to Admin and Secretary. Emergency data has a narrower read boundary. Finance permissions remain on existing finance routes. Later phases should replace repeated role lists with named permissions backed by a policy table, but Phase 1 uses explicit, testable functions to avoid broadening legacy access unintentionally.

## Future domain boundaries

Rank, position, meeting, correspondence, and communication tables will reference both `commandery_id` and the authoritative `member_id`. Histories are append-only. Issued artifacts store immutable rendered snapshots and attachment checksums. Safe template rendering will parse only allowlisted placeholders—never evaluate JavaScript/EJS or arbitrary object paths.

## Migration and rollback

The migration is additive except for dropping the old unique-name constraint, expanding the role constraint, and translating legacy `inactive` status. Back up PostgreSQL before deployment. Rollback should restore the previous application image while retaining additive columns/tables; do not drop new data. If application rollback is required after users have entered Phase 1 data, the old application can still read `members.name`, `phone`, `dob`, `status`, arrears, and notes, but it will not understand non-legacy statuses. Therefore validate migration and application together before reopening writes.
