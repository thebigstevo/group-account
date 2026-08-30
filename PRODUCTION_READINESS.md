# Production Readiness

## Runtime architecture

- Node.js 22, Express 4, server-rendered EJS, and PostgreSQL 16.
- Nginx terminates TLS and proxies only to loopback-bound application ports.
- Development and production use separate databases, application login roles, upload volumes, secrets, and Compose env files.
- The database owner is used only for migrations and operational backups; runtime containers use least-privilege roles.

## Release controls

- Pull requests and protected branches run Jest, production dependency audit, JavaScript and shell syntax checks, Compose validation, and a production Docker build.
- Deployment workflows are manually dispatched against committed Git state and share a concurrency lock for the VPS.
- Production deployment creates and verifies an S3 backup before migration, retains a rollback image, checks application health, and creates another verified S3 backup after startup.
- Production configuration refuses weak session, API, and database credentials.

## Security controls

- PBKDF2-SHA256 password hashing, PostgreSQL-backed sessions, session rotation on login/setup, secure production cookies, CSRF protection, and login/global rate limiting.
- Helmet security headers and a restrictive content-security policy.
- Role-based accounting, membership, administration, and trustee-audit permissions.
- Uploaded evidence is signature-validated and served only through authenticated finance/audit routes; upload volumes are included in backups.
- Sensitive actions are recorded in the audit trail, and accounting corrections use reversal records rather than deleting posted transactions.

## Backup and recovery

- `deploy/backup.sh` archives both databases and both upload volumes.
- Archives are gzip-tested, uploaded to the configured private/versioned S3 bucket with AES-256 server-side encryption and SHA-256 metadata, then verified by remote checksum and size.
- `deploy/restore.sh` restores database or upload archives from local files or S3 and requires an exact target confirmation.
- A production restore rehearsal must be recorded after material schema changes.

## Release acceptance checklist

- CI is green for the exact production commit.
- The production hostname resolves to the VPS and TLS succeeds.
- Required GitHub secrets and variables exist; no production secret is supplied to the development workflow.
- The pre-deployment S3 object is present and verifiable.
- `/health`, login/setup, desktop navigation, and 390-pixel mobile layout pass smoke testing.
- Database role isolation is verified in both directions.
- The latest database archive can be restored into an isolated rehearsal database and queried successfully.
