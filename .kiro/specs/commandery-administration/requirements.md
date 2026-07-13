# Commandery Administration Platform Requirements

## Scope and governing decisions

Treasurio will evolve in controlled phases from a finance application into a mobile-first, server-rendered commandery administration platform. The existing PostgreSQL `members` record remains authoritative and continues to serve all dues, receipts, welfare, and reporting relationships. No parallel member directory is permitted.

The corrected rank progression is: **Member → Lieutenant → Captain → Colonel → Brigadier General → Major General**. `Officer` is not a rank, must never appear in a rank selector, and is derived as `current rank >= Lieutenant`. Rank changes are explicit, forward-only, effective-dated, and never automatic.

## Phase 1 — Membership foundation (implementation scope)

### R1. Commandery and access scope

- Store a commandery identity and assign every member to one commandery.
- Support System Admin, President, First Vice President, Second Vice President, Secretary, Financial Secretary, Treasurer, Auditor, Trustee, Commander, Executive, and Viewer roles.
- System Admin and Secretary can create and edit member administration data.
- Emergency contacts are restricted to System Admin, President, Vice Presidents, Secretary, and Commander.
- Financial roles retain access to existing finance workflows without gaining membership-administration write access.

### R2. Authoritative member profile

- Generate a permanent, unique, human-readable membership number automatically.
- Store title, first/middle/last/preferred names, primary/secondary phone, email, date of birth, residential address, parish, occupation, first admission date, notes, photo reference, commandery, and status.
- Normalize Ghanaian local phone numbers to international form and accept valid international numbers.
- Permit duplicate human names; identity is based on membership number and explicit matching evidence.
- Preserve all existing member IDs and finance foreign keys.

### R3. Membership status

- Allowed statuses are Active, Suspended, Expelled, Transferred, and Resigned.
- Every change records previous status, new status, effective date, reason, optional supporting reference, actor, and timestamp.
- Status changes are append-only history events and cannot be silently overwritten through general profile editing.

### R4. Emergency contacts

- Store multiple contacts with relationship, primary/secondary phone, address, notes, and primary-contact marker.
- Emergency contacts are excluded from ordinary member list views and finance views.
- Creation and access are audited; hard deletion is not part of Phase 1.

### R5. Audit and mobile use

- Record actor, action, entity, entity ID, before/after values where relevant, reason, IP, user agent, and timestamp.
- Member list, profile, editing, status, and emergency-contact workflows must be usable on narrow mobile screens and retain server-side validation.

## Future phases (specified, not implemented now)

### Phase 2 — Membership history and ranks

- Add append-only rank history, position history, transfer history, and member timeline.
- Enforce forward-only progression through the corrected rank list.
- Derive `is_officer` from Lieutenant-or-higher; never store or select Officer as a rank.
- Positions include President, First/Second Vice President, Secretary, Assistant Secretary, Financial Secretary, Treasurer, Trustee 1/2/3, Commander, Deputy Commander, Second Vice Commander, Organiser, Welfare Officer, Protocol Officer, Sergeant-at-Arms, and configurable additions.
- Position appointments and endings require effective dates, actor, reason, and overlap checks.

### Phase 3 — Meetings and decisions

- Schedule meetings, record attendance/apologies/late arrival, agenda, minutes, decisions, action owners, deadlines, and completion.
- Approval workflow protects issued minutes from silent edits and creates revisions instead.

### Phase 4 — Finance, welfare, documents, and audit

- Retain the existing double-entry-like operational controls, dues, receipts, reversals, reconciliation, welfare allocation, and reports.
- Add document metadata/attachments, retention controls, export safeguards, backup verification, and audit review tools.

### Phase 5 — Communications, correspondence, and dashboards

- Provide Secretary-owned incoming/outgoing correspondence registers and reusable letter templates.
- Templates are versioned, categorized, permissioned, previewable, and use a safe placeholder allowlist (member, commandery, office holder, meeting, and reference fields only).
- Unknown placeholders fail validation; template rendering cannot execute code or expose unrelated records.
- Outgoing letters have unique references, draft/review/approval/issue states, PDF output, recipient/audience data, attachment metadata, delivery tracking, and immutable issued snapshots. Corrections create linked revisions.
- Incoming correspondence records sender, date, subject, reference, category, summary, routing, action owner, deadlines, response linkage, and attachments.
- Secretary drafts and manages registers; President or delegated approver approves configured categories; System Admin configures but does not implicitly approve content.
- Add targeted email/SMS/WhatsApp integrations, communication logs, consent/preferences, delivery status, and role-appropriate dashboards.

## Acceptance tests across the roadmap

- Existing member IDs and finance relationships survive migration.
- Membership numbers are unique under concurrent inserts.
- Unauthorized roles cannot mutate member profiles or see emergency contacts.
- Every status change creates exactly one history and audit event in one transaction.
- Officer is derived for Lieutenant and above, is false for Member, and is absent from selectable ranks.
- Rank reversal and skipped/automatic promotion are rejected unless a separately approved exceptional policy is introduced.
- Unknown or unsafe letter placeholders are rejected.
- Outgoing references are unique; approval rules are enforced; issued letters are immutable; revisions remain linked.
- Correspondence registers and attachments follow role and commandery boundaries.
