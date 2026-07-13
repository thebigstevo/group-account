# Delivery Plan

- [x] Assess current architecture, member model, finance references, roles, audit, and deployment shape.
- [x] Correct the domain model: Officer is derived, not selectable; capture Secretary correspondence requirements.
- [x] Add Phase 1 commandery, member profile, membership-number, status-history, emergency-contact, role, and audit schema.
- [x] Add Phase 1 server validation, least-privilege routes, profile/status/contact workflows, and responsive EJS views.
- [x] Complete automated unit tests and migration contract verification.
- [x] Run responsive desktop/mobile QA for member list and profile workflows.
- [ ] Run the migration twice against live PostgreSQL and verify legacy/finance row counts (local Docker backend unavailable).
- [ ] Run deployment smoke checks after the database backup and dev deployment.
- [ ] Phase 2: rank, position, transfer, and timeline histories.
- [ ] Phase 3: meeting, attendance, minutes, decisions, and actions.
- [ ] Phase 4: finance/audit/document hardening.
- [ ] Phase 5: correspondence, letter templates/PDFs, communications, and dashboards.
