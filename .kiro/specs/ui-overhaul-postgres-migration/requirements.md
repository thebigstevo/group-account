# Requirements Document

## Introduction

This feature modernizes the application — rebranded from "KSJI Accounts" to **"Treasurio by TILC"** — in three complementary areas: (1) a rebrand to a generic club/society/group-friendly identity so any organization can deploy and use it; (2) a UI/UX overhaul that transforms the current basic EJS templates into a polished, responsive, and accessible interface with improved navigation, visual hierarchy, and interaction patterns; and (3) a database migration from SQLite (better-sqlite3) to PostgreSQL, served via Docker Compose alongside the application container, providing better concurrency, data integrity, and production-readiness for multi-user access.

## Glossary

- **Application**: The Treasurio by TILC Node.js/Express web application serving EJS templates
- **Design_System**: The set of reusable CSS variables, components, typography, spacing, and color tokens used across all views
- **Sidebar_Navigation**: A persistent vertical navigation panel on the left side of the viewport replacing the current horizontal top navigation bar
- **Dashboard_View**: The main landing page showing financial overview, work queue, and recent transactions
- **Data_Table**: A styled HTML table component with sorting indicators, pagination controls, and row-level actions
- **Form_Component**: A styled HTML form with grouped fields, inline validation feedback, and accessible labels
- **Toast_Notification**: A temporary message overlay displayed after successful or failed user actions
- **Modal_Dialog**: A centered overlay panel used for confirmations and quick data entry without full page navigation
- **Database_Layer**: The module (db.js) responsible for connecting to the database and executing queries
- **Migration_Script**: A Node.js script that creates the PostgreSQL schema tables, indexes, and seed data
- **Docker_Compose_Stack**: The docker-compose.yml configuration defining the Application and PostgreSQL services
- **Connection_Pool**: A managed set of reusable PostgreSQL client connections provided by the pg library
- **Data_Migration_Tool**: A script that reads existing SQLite data and inserts it into the PostgreSQL database

## Requirements

### Requirement 1: Design System Foundation

**User Story:** As a developer, I want a consistent design system with defined tokens and reusable component styles, so that all views share a cohesive visual language and future changes are centralized.

#### Acceptance Criteria

1. THE Design_System SHALL define CSS custom properties in the :root scope for color palette (primary, secondary, success, warning, danger, and neutral scales with a minimum of 3 shades each), a spacing scale based on a 4px base unit with at least 6 steps (4px, 8px, 12px, 16px, 24px, 32px), a minimum of 3 border-radius tokens (small 4px, medium 8px, large 12px), and a typographic scale
2. THE Design_System SHALL provide a base font stack using a system font stack with fallbacks and define sizes for headings (h1: 30px/1.875rem, h2: 24px/1.5rem, h3: 20px/1.25rem, h4: 16px/1rem), body text (16px/1rem), captions (12px/0.75rem), and labels (13px/0.8125rem)
3. THE Design_System SHALL include transition duration tokens defined as CSS custom properties: hover states (150ms), focus rings (100ms), and panel open/close animations (250ms)
4. THE Design_System SHALL define focus-visible outlines with a minimum width of 2px, a minimum offset of 3px, in the primary color for all interactive elements to satisfy WCAG 2.1 AA focus visibility requirements

### Requirement 2: Sidebar Navigation

**User Story:** As a finance officer, I want a persistent sidebar navigation that organizes menu items into logical groups, so that I can quickly access any section of the application without scrolling through a crowded top bar.

#### Acceptance Criteria

1. THE Sidebar_Navigation SHALL display a fixed vertical panel with a width between 220px and 260px on viewports wider than 768px, containing grouped navigation links: Operations (Dashboard, Transactions, Members), Reporting (Reports, Reconciliation, Downloads), and Administration (Config, Dues, Fiscal Years, Users, Audit)
2. THE Sidebar_Navigation SHALL highlight the currently active navigation group and link by applying a visually distinct background color and a left-border accent of at least 3px width, where "active" is determined by matching the current page path to its parent navigation group
3. WHILE the viewport width is 768px or narrower, THE Sidebar_Navigation SHALL collapse into a hidden drawer accessible via a hamburger icon displayed in a compact top bar
4. THE Sidebar_Navigation SHALL display the logged-in user's name (truncated with ellipsis if exceeding 20 characters), a role badge showing the user's role, and a sign-out action at the bottom of the panel
5. IF the logged-in user's role is not one of admin, finance_secretary, or treasurer, THEN THE Sidebar_Navigation SHALL hide the Administration group links except for Audit, which SHALL remain visible to users with the auditor role; users with admin, finance_secretary, or treasurer roles SHALL see the full Administration group with all links visible
6. WHEN the user activates the hamburger icon on viewports 768px or narrower, THE Sidebar_Navigation SHALL open as a slide-out drawer with a backdrop overlay of at least 40% opacity, and SHALL close when the user taps the backdrop, selects a navigation link, or presses the Escape key

### Requirement 3: Dashboard Redesign

**User Story:** As a finance officer, I want a dashboard with clear visual hierarchy, summary cards, and contextual charts, so that I can assess the group's financial health at a glance.

#### Acceptance Criteria

1. THE Dashboard_View SHALL display summary metric cards for each active account balance, total income, total expenses, welfare liability, and spendable estimate using the Design_System metric card component, with all monetary values formatted in the configured group currency
2. THE Dashboard_View SHALL present the work queue as a compact card list showing uncleared transaction count, members with arrears count, active member count, and latest reconciliation date, where each item links to its corresponding detail view (Transactions, Reports, Members, Reconciliation)
3. THE Dashboard_View SHALL render the recent transactions section as a Data_Table limited to the 10 most recent posted transactions sorted by transaction date descending then by transaction ID descending, with columns: Date, Type badge, Member, Account, Category, and Amount
4. THE Dashboard_View SHALL provide quick-action buttons (Record Receipt, Record Expense, Reconcile, View Reports) in a top action bar positioned between the page heading and the metrics section
5. THE Dashboard_View SHALL arrange content in a responsive grid: two-column on viewports wider than 768px (metrics row spanning full width, work queue and recent transactions side by side) collapsing to single-column on viewports 768px or narrower
6. IF the Dashboard_View has no posted transactions to display, THEN THE Dashboard_View SHALL render the recent transactions section with an empty-state message indicating no transactions have been recorded yet
7. IF the Dashboard_View fails to load summary data due to a server error, THEN THE Application SHALL display an error message in place of the metrics section indicating that financial data is temporarily unavailable

### Requirement 4: Data Table Component

**User Story:** As a user viewing lists of members, transactions, or audit entries, I want sortable and paginated tables with clear row actions, so that I can efficiently browse and act on large datasets.

#### Acceptance Criteria

1. WHEN a user clicks a column header, THE Data_Table SHALL sort rows by that column in ascending order on the first click and toggle to descending order on a subsequent click, displaying an upward or downward arrow indicator on the active sort column only
2. THE Data_Table SHALL provide client-side pagination with a default page size of 10 rows, a page-size selector offering 10, 25, and 50 rows, and navigation controls (previous button, next button, and up to 5 visible page number buttons)
3. THE Data_Table SHALL include a search input that performs case-insensitive substring matching across all displayed columns, filtering visible rows as the user types with a debounce delay of 300 milliseconds, and resetting pagination to the first page when the filter value changes
4. THE Data_Table SHALL render row-level action buttons in a final Actions column using icon buttons with accessible aria-labels, where the available actions are determined by the row's data type regardless of dataset context: edit for member rows, reverse for posted transaction rows, and reconcile for uncleared transaction rows
5. WHEN the Data_Table contains no matching rows after filtering or when the underlying dataset is empty, THE Data_Table SHALL display a centered empty-state message indicating no results found
6. WHILE the viewport width is 768px or narrower, THE Data_Table SHALL scroll horizontally within its container while keeping the first column (identifier or date) fixed in position via sticky positioning; sticky positioning SHALL also remain active on wider viewports to maintain consistent column behavior
7. IF the user clicks a sort column header while a search filter is active, THEN THE Data_Table SHALL sort the filtered result set without clearing the current search term

### Requirement 5: Form UX Improvements

**User Story:** As a finance officer entering transactions or managing members, I want forms with clear grouping, inline validation, and contextual guidance, so that I make fewer data-entry errors.

#### Acceptance Criteria

1. THE Form_Component SHALL group related fields into labeled fieldsets (e.g., "Transaction Details", "Amount & Allocation") with 1px divider lines between groups using the Design_System neutral color scale
2. THE Form_Component SHALL mark required fields with a visible asterisk (*) adjacent to the field label and provide a legend stating "* Required" at the top of the form
3. THE Form_Component SHALL display inline validation messages below the relevant field within 200ms of the field losing focus, using the Design_System danger color and a warning icon for errors, and validate at minimum: required fields are non-empty, numeric amount fields contain a value between 0.00 and 999999999.99 (allowing zero for refunds or corrections), and date fields contain a valid calendar date
4. THE Form_Component SHALL disable the submit button on initial form load while any required field is empty, and re-disable it whenever a required field becomes empty or contains a validation error
5. WHEN a form submission succeeds, THE Application SHALL display a Toast_Notification confirming the action (e.g., "Receipt recorded successfully") for the full 4 seconds before auto-dismissing, regardless of whether the user navigates away from the form
6. IF a form submission fails due to server-side validation, THEN THE Application SHALL re-render the form with all previously entered field values preserved and display each server-returned error message at the top of the form in a summary list using the Design_System danger color
7. THE Form_Component SHALL use date-picker inputs for transaction date fields, falling back to the browser native date input when the date-picker component fails to initialize, and SHALL constrain selectable dates to the currently active fiscal year date range
8. THE Form_Component SHALL display a brief helper text (maximum 80 characters) below amount and welfare-portion fields describing expected input (e.g., "Enter total amount received including welfare portion")

### Requirement 6: Toast Notifications

**User Story:** As a user performing actions, I want brief confirmation or error messages that appear without blocking my workflow, so that I know whether my action succeeded.

#### Acceptance Criteria

1. WHEN a user action succeeds (transaction created, member saved, reconciliation recorded), THE Toast_Notification SHALL appear in the top-right viewport corner with 16px offset from the top and right edges, display a success color theme with the action description, and auto-dismiss after 4 seconds
2. IF a server error occurs during form submission, THEN THE Toast_Notification SHALL appear with a danger color theme and remain visible until manually dismissed by the user
3. THE Toast_Notification SHALL include a close button accessible via keyboard (Enter or Space key) with an aria-label of "Dismiss notification"
4. THE Toast_Notification SHALL stack vertically when multiple notifications are active (maximum 3 visible simultaneously), with newest appearing at the top and oldest auto-dismissing when the limit is exceeded
5. THE Toast_Notification SHALL be announced to screen readers using role="status" for success-themed messages and role="alert" for error-themed messages, where the role is determined by the notification's visual theme rather than the underlying server state

### Requirement 7: Modal Confirmation Dialogs

**User Story:** As a finance officer, I want confirmation prompts before irreversible actions like transaction reversals or fiscal year closures, so that I avoid accidental destructive operations.

#### Acceptance Criteria

1. WHEN the user initiates a transaction reversal, THE Modal_Dialog SHALL display a confirmation with the transaction details (date, type, amount) and two buttons: "Confirm Reversal" and "Cancel"
2. WHEN the user initiates fiscal year closure, THE Modal_Dialog SHALL display the year, a summary of impact (number of members affected, arrears carry-forward amount), and two buttons: "Confirm Closure" and "Cancel"
3. WHILE the Modal_Dialog is open, THE Modal_Dialog SHALL trap keyboard focus within the dialog, prevent pointer interaction with content behind the backdrop overlay, and return focus to the triggering element on close
4. WHEN the user presses Escape, clicks the backdrop overlay, or activates the Cancel button, THE Modal_Dialog SHALL close without executing the destructive action; the Modal_Dialog SHALL require explicit activation of the Confirm button before any destructive action is executed
5. WHEN the user activates the confirm button, THE Modal_Dialog SHALL close and the Application SHALL execute the requested action (reversal or closure) and display a Toast_Notification indicating the outcome; IF the user presses Escape while the action is already processing, THE Application SHALL allow the action to complete
6. THE Modal_Dialog SHALL use role="alertdialog" with an aria-labelledby attribute referencing the dialog heading and an aria-describedby attribute referencing the impact summary text

### Requirement 8: Responsive Layout

**User Story:** As a finance officer using a tablet or phone, I want the application to remain usable and readable on smaller screens, so that I can check balances or enter quick transactions on the go.

#### Acceptance Criteria

1. THE Application SHALL render all views on viewports from 320px to 1920px wide without horizontal overflow, content truncation, or text overlap, maintaining a minimum rendered font size of 14px for body text and 12px for captions and labels
2. WHILE the viewport width is 768px or narrower, THE Application SHALL stack grid columns into a single column layout and increase touch target sizes to a minimum of 44px by 44px with at least 8px spacing between adjacent targets
3. WHILE the viewport width is 768px or narrower, THE Application SHALL collapse the Sidebar_Navigation into the hamburger drawer and display a top bar no taller than 56px containing the brand mark and hamburger icon
4. THE Application SHALL use relative units (rem, em, %) for typography and spacing such that increasing the browser default font size to 200% does not cause horizontal overflow, content overlap, or loss of functionality
5. WHEN the device orientation changes between portrait and landscape, THE Application SHALL reflow content to fit the new viewport dimensions within 1 second without requiring a page reload

### Requirement 9: PostgreSQL Database Migration

**User Story:** As the system administrator, I want the application to use PostgreSQL instead of SQLite, so that the database supports concurrent access, proper data types, and standard production tooling.

#### Acceptance Criteria

1. THE Database_Layer SHALL connect to PostgreSQL using the pg library with a Connection_Pool of configurable size read from the PG_POOL_SIZE environment variable, defaulting to 10 connections when PG_POOL_SIZE is not set, with a minimum of 1 and maximum of 100 connections
2. THE Database_Layer SHALL read connection parameters from environment variables: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, and DATABASE_URL, where DATABASE_URL takes precedence over individual variables when both are set
3. IF neither DATABASE_URL nor the required individual connection variables (PGHOST, PGDATABASE, PGUSER) are set at startup, THEN THE Database_Layer SHALL terminate the process with a non-zero exit code and log an error message indicating the missing connection configuration; IF DATABASE_URL is set, THEN the individual variables SHALL NOT be considered required and no error SHALL be logged for their absence
4. THE Migration_Script SHALL create all tables (users, members, accounts, dues_rules, payment_splits, transaction_categories, member_dues, transactions, reconciliations, fiscal_years, audit_log) with equivalent column types mapped from SQLite to PostgreSQL (INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY, TEXT → VARCHAR(255) for constrained fields and TEXT for unconstrained fields, REAL → NUMERIC(12,2), INTEGER boolean columns (0/1) → BOOLEAN), preserving all CHECK constraints, UNIQUE constraints, and foreign key relationships from the existing schema
5. THE Migration_Script SHALL be idempotent such that running it multiple times against an existing PostgreSQL database produces no errors and does not duplicate or alter existing data
6. THE Migration_Script SHALL create all indexes equivalent to the existing SQLite indexes (idx_transactions_date, idx_transactions_type_status, idx_transactions_member_year, idx_transactions_account_date, idx_reconciliations_account_period, idx_audit_log_created_at) using CREATE INDEX IF NOT EXISTS
7. THE Migration_Script SHALL seed default accounts (Cash with type 'cash', Bank with type 'bank', Mobile Money with type 'mobile_money') and default transaction categories (Assessment, Welfare, Anniversary, Offertory, Ad hoc as income; General Expense, PCT, Convention Fees, Refreshment, Support, Welfare Payout as expense) only when their respective tables contain zero rows
8. THE Database_Layer SHALL use parameterized queries with $1, $2 placeholder syntax for all SQL statements to prevent injection
9. THE Database_Layer SHALL replace SQLite-specific functions: strftime('%Y', tx_date) with EXTRACT(YEAR FROM tx_date), CURRENT_TIMESTAMP with NOW(), and SQLite PRAGMA foreign_keys with PostgreSQL's native foreign key enforcement
10. IF the Database_Layer cannot establish a connection to PostgreSQL within 5 seconds during pool initialization, THEN THE Database_Layer SHALL retry the connection up to 3 times with a 2-second delay between attempts, and terminate the process with a non-zero exit code if all retries are exhausted

### Requirement 10: Docker Compose PostgreSQL Service

**User Story:** As the system administrator, I want a Docker Compose configuration that runs both the application and PostgreSQL containers, so that I can deploy the full stack with a single command.

#### Acceptance Criteria

1. THE Docker_Compose_Stack SHALL define a postgres service using the official postgres:16-alpine image with a named volume (pgdata) mounted at /var/lib/postgresql/data for persistence
2. THE Docker_Compose_Stack SHALL configure the postgres service with environment variables POSTGRES_DB (default: ksji_accounts), POSTGRES_USER (default: ksji), and POSTGRES_PASSWORD (default: changeme) using variable substitution with fallback values
3. THE Docker_Compose_Stack SHALL configure the accounts application service with environment variables pointing to the postgres service hostname (PGHOST=postgres, PGPORT=5432) and matching database credentials (PGUSER, PGPASSWORD, PGDATABASE)
4. THE Docker_Compose_Stack SHALL define a depends_on relationship with condition: service_healthy so the accounts service starts only after the postgres service passes its healthcheck
5. THE Docker_Compose_Stack SHALL include a healthcheck on the postgres service using pg_isready with 5-second interval, 5-second timeout, 5 retries, and a start_period of 10 seconds
6. THE Docker_Compose_Stack SHALL remove the SQLite volume (accounts_data) and DB_PATH environment variable from the accounts service configuration
7. THE Docker_Compose_Stack SHALL expose port 3000 on the accounts service for HTTP access

### Requirement 11: Data Access Layer Abstraction

**User Story:** As a developer, I want the database access code abstracted behind a consistent interface, so that queries are centralized and the switch from SQLite syntax to PostgreSQL syntax is contained in one module.

#### Acceptance Criteria

1. THE Database_Layer SHALL export query helper functions: query(sql, params) returning an array of row objects, queryOne(sql, params) returning the first row object or null when no rows match, and run(sql, params) returning a result object with rowCount property and rows array (for RETURNING clauses), where params is an array of values matching $1, $2 placeholders
2. THE Database_Layer SHALL export a transaction helper function that accepts an async callback, acquires a dedicated client from the Connection_Pool, executes BEGIN, runs the callback passing the client, issues COMMIT on success, issues ROLLBACK and re-throws the original error on failure, and releases the client back to the pool in all cases
3. IF a connection error occurs during pool initialization or query execution, THEN THE Database_Layer SHALL log the error with timestamp and error code, retry the operation with exponential backoff (initial delay 1 second, multiplier 2x, maximum 3 retries), and throw the original error if all retries are exhausted
4. THE Database_Layer SHALL export a shutdown function that drains and closes the Connection_Pool for use during graceful application shutdown

### Requirement 12: SQLite to PostgreSQL Data Migration Tool

**User Story:** As the system administrator, I want a migration script that transfers existing SQLite data to the new PostgreSQL database, so that no historical records are lost during the transition.

#### Acceptance Criteria

1. THE Data_Migration_Tool SHALL read all rows from the existing SQLite database file (path provided via environment variable SQLITE_PATH) and insert them into the corresponding PostgreSQL tables preserving primary key values, converting SQLite types to PostgreSQL equivalents: TEXT date strings preserved as-is into VARCHAR/TEXT columns, REAL values into NUMERIC(12,2), and INTEGER boolean columns (0/1) into PostgreSQL BOOLEAN (false/true)
2. THE Data_Migration_Tool SHALL migrate tables in dependency order: users, members, accounts, fiscal_years, dues_rules, payment_splits, transaction_categories, member_dues, transactions, reconciliations, audit_log
3. THE Data_Migration_Tool SHALL reset PostgreSQL sequences to MAX(id) + 1 for each table that uses a SERIAL primary key (all tables except fiscal_years which uses year as its primary key), and set the sequence to 1 if the table contains no rows
4. THE Data_Migration_Tool SHALL execute the full migration within a single PostgreSQL transaction, rolling back all changes if any table migration fails
5. THE Data_Migration_Tool SHALL log progress for each table (table name, rows migrated, duration) and output a final summary with total rows migrated and total elapsed time
6. IF the target PostgreSQL tables already contain data, THEN THE Data_Migration_Tool SHALL abort with an error message indicating that the database is not empty and migration cannot proceed, and exit with a non-zero error code
7. IF the SQLITE_PATH environment variable is not set or the file at that path does not exist or is not a valid SQLite database, THEN THE Data_Migration_Tool SHALL abort with an error message indicating the specific problem and exit with a non-zero exit code
8. WHEN migration completes successfully and row-count verification passes with no discrepancies, THE Data_Migration_Tool SHALL exit with code 0; IF verification detects row-count discrepancies, THE Data_Migration_Tool SHALL report the discrepancies and exit with a non-zero error code

### Requirement 13: Session Store Migration

**User Story:** As a developer, I want the session store to use PostgreSQL instead of SQLite, so that sessions are stored in the same database engine and benefit from connection pooling.

#### Acceptance Criteria

1. THE Application SHALL use the connect-pg-simple session store backed by the PostgreSQL Connection_Pool, replacing the SQLiteSessionStore module
2. THE Migration_Script SHALL create the session table with the schema required by connect-pg-simple (sid VARCHAR NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TIMESTAMP(6) NOT NULL) and an index on the expire column
3. THE Application SHALL configure the session store with a prune interval of 60 minutes to remove expired sessions automatically
4. IF the PostgreSQL connection is unavailable during a session read or write operation, THEN THE Application SHALL respond with an HTTP 503 status and render an error page indicating the service is temporarily unavailable

### Requirement 14: Print and Export Styling

**User Story:** As a finance officer, I want printed reports and downloaded pages to render cleanly without navigation chrome or decorative elements, so that I can produce professional-looking physical documents.

#### Acceptance Criteria

1. WHEN the browser print function is invoked, THE Application SHALL hide the Sidebar_Navigation, Toast_Notification stack, hamburger icon, and all action buttons via @media print styles
2. WHEN the browser print function is invoked, THE Application SHALL expand Data_Table components to full page width without horizontal scroll, display all rows regardless of pagination state, and remove the search input and pagination controls
3. THE Application SHALL include a print-optimized header on each printed page showing the group name ("Treasurio by TILC"), the current view title, and the print date formatted as DD/MM/YYYY
4. WHEN printing, THE Application SHALL set the page body background to white and all text to black for maximum readability and ink efficiency

### Requirement 15: Accessibility Compliance

**User Story:** As a user with assistive technology, I want the application to follow accessibility best practices, so that I can navigate and operate all features using a screen reader or keyboard alone.

#### Acceptance Criteria

1. THE Application SHALL use semantic HTML landmarks (nav, main, header, footer, section) and SHALL provide a unique descriptive aria-label on each landmark when more than one instance of the same landmark type exists on a page
2. THE Application SHALL provide a skip-navigation link as the first focusable element on each page that moves keyboard focus directly to the main content region, and SHALL ensure all interactive elements are reachable via keyboard Tab navigation in visual left-to-right, top-to-bottom document order
3. THE Application SHALL maintain a minimum contrast ratio of 4.5:1 for body text and 3:1 for large text (18px or above, or 14px bold or above) against background colors per WCAG 2.1 AA
4. THE Application SHALL associate all form inputs with visible label elements using the for/id attribute pairing
5. THE Application SHALL announce dynamic content changes to screen readers using aria-live="assertive" or role="alert" for error states (form validation errors, server error notifications) and aria-live="polite" for success confirmations (Toast_Notification success, Modal_Dialog open/close)
6. WHEN the user navigates to a new view, THE Application SHALL update the HTML document title to reflect the current view name followed by the application name (e.g., "Transactions – Treasurio")

### Requirement 16: Application Rebrand

**User Story:** As a group administrator deploying the application, I want the app branded as "Treasurio by TILC" with configurable group name, so that any club, society, or organization can adopt it without code changes.

#### Acceptance Criteria

1. THE Application SHALL display "Treasurio" as the product name in the Sidebar_Navigation header, login page, and browser tab title, with "by TILC" displayed as a smaller subtitle or footer credit
2. THE Application SHALL read the deploying organization's name from an environment variable GROUP_NAME (defaulting to "My Group") and display it in the Dashboard_View header, printed report headers, and SMS message templates
3. THE Application SHALL read an optional GROUP_CURRENCY environment variable (defaulting to "GHS") and use it for all monetary formatting throughout the interface and reports
4. THE Application package.json SHALL use the name "treasurio" and the description SHALL reference generic group/club/society financial management
5. THE Application SHALL render a configurable logo area in the Sidebar_Navigation header that displays "Treasurio" as a text-based logo by default, and accepts a custom logo image via a /public/logo.png file if present (the text logo remains visible when no custom image is provided)
6. THE Application README and documentation SHALL describe the product as "Treasurio — Group & Club Financial Management" without references to any specific organization

### Requirement 17: VPS Platform Integration

**User Story:** As the system administrator, I want the application to deploy as a standard app within the VPS platform framework (apps/treasurio/), so that it integrates with the shared Nginx reverse proxy, centralized backup system, and standard deployment workflow.

#### Acceptance Criteria

1. THE Application SHALL provide a deployment directory structure following the VPS platform convention: apps/treasurio/ containing docker-compose.yml, .env (generated by deploy script), deploy-treasurio.sh, backup.sh, restore.sh, remove-treasurio.sh, and README.md
2. THE Docker_Compose_Stack SHALL bind the accounts service port only to 127.0.0.1 (e.g., "127.0.0.1:${APP_PORT:-3100}:3000") so that only the host's shared Nginx reverse proxy can route traffic to the container; IF the binding is changed to a public interface, THE Application SHALL log a security warning at startup but SHALL NOT prevent deployment
3. THE deploy-treasurio.sh script SHALL interactively prompt for the application domain name and port, generate the .env file with all required variables (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, SESSION_SECRET, N8N_API_TOKEN, GROUP_NAME, GROUP_CURRENCY, APP_PORT, DOMAIN), and output the Nginx server block configuration to add for the domain
4. THE Docker_Compose_Stack SHALL define an isolated Docker network (treasurio-net) for internal communication between the accounts and postgres services, with both containers using restart policy "unless-stopped"
5. THE backup.sh script SHALL dump the PostgreSQL database using pg_dump into a timestamped .sql.gz file stored in a backups/ subdirectory, retaining the last 7 backups by default
6. THE restore.sh script SHALL accept a backup file path as argument, drop and recreate the database, and restore from the specified .sql.gz dump file
7. THE remove-treasurio.sh script SHALL stop and remove all containers, remove the Docker network, and optionally delete the pgdata volume when a --purge flag is provided
8. THE Application SHALL respond to HTTP health check requests on GET /health with a JSON body containing status "ok" and a database connectivity check result, returning HTTP 200 when healthy and HTTP 503 when the database is unreachable
9. THE Application Dockerfile SHALL use a multi-stage build with a Node.js 22 alpine base image, install only production dependencies in the final stage, and set NODE_ENV=production
10. THE Application README.md in the apps/treasurio/ directory SHALL document the deployment steps, environment variables, backup/restore procedures, and Nginx configuration snippet for the reverse proxy
