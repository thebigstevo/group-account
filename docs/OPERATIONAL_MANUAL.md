# Treasurio Operational Manual

**System:** KSJI 825 Treasurio  
**Address:** [https://ksji825.tilcsaas.com](https://ksji825.tilcsaas.com)  
**Audience:** Administrators, executives, finance officers, secretaries, trustees, auditors, and read-only users  
**Purpose:** A simple guide for setting up and operating Treasurio without requiring advanced computer knowledge

---

## How to use this manual

1. The administrator should complete **Part 1** before other users begin work.
2. Every user should read **Part 2**.
3. Each officer should then read the section for their assigned role in **Part 4**.
4. Follow menu paths exactly as written. For example:

   `Menu → Finance → Income → Record Income`

5. On a phone, tap the three-line **Menu** button to open the same menu shown permanently on a computer.

> **Important:** If a menu item or button is not visible, your role probably does not have permission to use it. Ask the administrator. Do not share another person's account.

### Which sections should I read?

| Your role | Read these sections |
|---|---|
| Administrator | Parts 1–3, Part 4A, and Parts 5–9 |
| Treasurer | Parts 2–3, Part 4B, and Parts 5–9 |
| Finance Secretary | Parts 2–3, Part 4C, and Parts 5–9 |
| Secretary | Parts 2–3, Part 4D, Part 7, and Part 8 |
| Trustee or Auditor | Parts 2–3, Part 4E, and Parts 5–9 |
| President, Vice President, Commander, Executive, or Viewer | Parts 2–3, Part 4F, Part 5, Part 7, and Part 8 |

---

# Part 1 — Administrator: fresh installation

The administrator is responsible for the initial setup, user accounts, system configuration, and final approval of controlled actions.

## 1. Information to gather before setup

Have the following information ready:

- Official organization name and short name
- Currency, normally **GHS — Ghana Cedi**
- Opening fiscal year
- List of bank, cash, and mobile money accounts
- Opening balance for each account as at the agreed starting date
- Income and expense categories
- Annual dues and welfare rules
- Member register and opening arrears or credits
- Annual budget, if already approved outside the system
- Names, email addresses, and roles of system users
- Names and titles of report signatories

Agree one common **cut-off date** for all opening balances. Do not mix figures from different dates.

## 2. Create the first administrator

Open [Initial setup](https://ksji825.tilcsaas.com/setup), or visit the main address on a fresh installation.

Complete the three sections:

1. **Admin Account**
   - Enter the administrator's full name.
   - Enter an email address the administrator can access.
   - Create a unique password. Use at least 12 characters even though the form accepts 8.
   - Enter the password again under **Confirm Password**.
2. **Organization**
   - Enter the official organization name.
   - Select the correct currency.
3. **First Fiscal Year**
   - Enter the year in which records will begin.
4. Select **Complete Setup & Log In**.

The setup creates the first administrator, organization record, and active fiscal year together.

> Store the administrator password securely. Do not send it through an ordinary group chat.

## 3. Complete the organization profile

Path: `Menu → Administration → Organization`  
Direct page: [Organization](https://ksji825.tilcsaas.com/organization)

Complete:

- **Identity:** official name, short name, registration number, year founded, currency, and motto
- **Contact & Address:** postal address, town, region, country, telephone, email, and website
- **Letterhead:** up to three lines for official reports
- **Report Signatories:** names and titles shown on printed reports
- **SMS Notifications:** configure only if the organization has a valid mNotify account

Select **Save Organization Profile**.

## 4. Create the financial structure

Path: `Menu → Administration → Settings`  
Direct page: [Settings](https://ksji825.tilcsaas.com/config)

Complete this page before recording transactions.

### 4.1 Accounts

Under **Accounts**, add every place where money is held, for example:

- Cash
- Republic Bank
- Mobile Money
- Welfare Bank Account

For each account:

1. Enter the account name.
2. Select the correct type.
3. Enter the opening balance at the agreed cut-off date.
4. Select **Add account**.

Check the total against the cash count and bank/mobile money statements.

### 4.2 Transaction categories

Under **Transaction categories**, add the headings used in the books.

For each category:

1. Enter the name, such as **Offertory**, **Transport Appeal**, **Assessment**, or **General Expense**.
2. Select its **Kind**:
   - **Income** — money only comes in under this category.
   - **Expense** — money only goes out under this category.
   - **Income & expense** — the same purpose can receive and spend money. Use this for categories such as offertory or a transport appeal when funds may later be paid to an external party.
3. Select its **Accounting purpose**:
   - **Standard** — ordinary income or expense.
   - **Member assessment** — payments that reduce a named member's dues balance.
   - **Welfare collection** — money collected for welfare.
   - **Welfare payout** — welfare money paid out.
4. Set a display order if required.
5. Select **Save category**.

Do not create slightly different spellings for the same category. This divides reports unnecessarily.

### 4.3 Welfare split rules

Use **Welfare split rules** where one assessment payment contains both ordinary assessment and welfare.

1. Select the assessment category.
2. Enter the full assessment amount.
3. Enter the welfare part included in that amount.
4. Select **Save split**.

The system will use the rule when allocating qualifying receipts. A rule that already affects posted receipts is locked to protect historical figures.

## 5. Configure dues

Path: `Menu → Administration → Dues & rules`  
Direct page: [Dues and rules](https://ksji825.tilcsaas.com/dues)

### Add an annual rule

1. Confirm the correct year.
2. Enter a clear label, for example **Members aged 18–64**.
3. Enter minimum and maximum ages if the rule is age-based.
4. Enter **Total assessment**, including welfare.
5. Enter the **Welfare portion**.
6. Select **Add rule**.

Create rules that cover the intended membership without overlapping incorrectly.

### Give one member a different amount

Use **Override a member** only when an approved exception exists.

1. Select the member.
2. Enter the total assessment and welfare portion.
3. State the reason.
4. Select **Save override**.

## 6. Configure ranks and positions

These pages are available to administrators and secretaries by direct address:

- [Manage ranks](https://ksji825.tilcsaas.com/config/ranks)
- [Manage positions](https://ksji825.tilcsaas.com/config/positions)

Add the official titles that should appear in member histories. Deactivate an old title instead of creating inconsistent alternatives.

## 7. Enter or import members

Path: `Menu → Overview → Members`  
Direct page: [Members](https://ksji825.tilcsaas.com/members)

### Add one member

1. Select **Add Member**.
2. Enter at least first name and last name.
3. Add the available contact and admission information.
4. Select **Create member record**.
5. Open the member and add status, rank, degree, position, transfer, or emergency-contact records where applicable.

### Import many members

Path: `Members → Import register`  
Direct page: [Import members](https://ksji825.tilcsaas.com/members/import)

1. Prepare a `.csv` or `.xlsx` file.
2. Include **Name**. Membership Number is strongly recommended when correcting existing records.
3. Optional headings include Phone, DOB, Status, and Opening Arrears.
4. Use positive opening arrears when a member owes money, negative values for credit, and zero for neither.
5. Choose the file and select **Upload and import**.
6. Read the result summary. Check imported, skipped, positive, credit, and zero counts.

For cleanup work, select **Download cleanup register**, edit only the permitted columns, retain membership numbers, and upload the corrected file.

Only the administrator can roll back a tracked import. Do not roll back an import after later member activity without checking the warning carefully.

## 8. Enter the annual budget

Path: `Menu → Finance → Annual budget`  
Direct page: [Annual budget](https://ksji825.tilcsaas.com/budgets)

1. Select the fiscal year and choose **View year**.
2. Under **Add or update a budget line**, select Income or Expense.
3. Select the category.
4. Enter the annual amount and any note.
5. Select **Save budget line**.
6. Repeat until all approved lines are entered.
7. Compare the totals with the approved paper budget.
8. Select **Approve and lock budget**.

Approval prevents accidental edits. Actual figures continue updating from posted transactions. If the budget must be changed later, the administrator must enter a reason and select **Reopen budget**.

## 9. Create users and assign roles

Path: `Menu → Administration → Users`  
Direct page: [Users](https://ksji825.tilcsaas.com/users)

For each user:

1. Enter their name and email.
2. Give them a temporary password.
3. Select the smallest role that matches their actual duty.
4. Select **Add user**.
5. Give the credentials directly to that person.
6. Ask them to sign in and change the temporary password under `Menu → Account`.

Avoid giving **Administrator** to every executive. Use the role table in Part 3.

## 10. Administrator acceptance check

Before handing over, confirm all of the following:

- [ ] Organization name and report signatories are correct.
- [ ] Currency and fiscal year are correct.
- [ ] Account opening balances agree with source records.
- [ ] Categories include Income, Expense, or Income & expense as required.
- [ ] Assessment and welfare purposes are assigned correctly.
- [ ] Dues rules and welfare splits are correct.
- [ ] Member opening arrears and credits have been checked.
- [ ] Annual budget has been entered and approved.
- [ ] Every officer has their own account and correct role.
- [ ] One small test transaction has been entered, reviewed, and reversed if it was only a test.
- [ ] Finance officers can see their expected menus.
- [ ] Trustees/auditors can open the audit workspace but cannot edit the books.

---

# Part 2 — Instructions for every user

## Sign in

1. Open [Treasurio](https://ksji825.tilcsaas.com).
2. Enter your email and password.
3. Select **Sign in**.

If you cannot sign in, check spelling and capital letters. After repeated failure, ask the administrator to reset the password.

## Use Treasurio on a phone

1. Tap the three-line **Menu** button at the top.
2. Tap the required section.
3. The menu closes after selection.
4. Tables may appear as cards or may scroll sideways on small screens.

## Change your password

Path: `Menu → Account`  
Direct page: [Account](https://ksji825.tilcsaas.com/change-password)

Enter the current password, then the new password twice. Use a password not used on another service.

## Sign out

Select `Menu → Sign out`, especially on a shared computer or phone.

## General operating rules

- Use your own account. The audit trail records who performed each action.
- Check the active fiscal year before entering money.
- Enter the transaction date shown on the receipt, voucher, bank statement, or mobile money record.
- Add receipt, voucher, cheque, bank, or mobile money references whenever available.
- Use a clear description that another officer can understand later.
- Do not invent a new category because a suitable one is difficult to find; ask an administrator or finance officer.
- Never delete or disguise a correct historical transaction. Reverse an incorrect posted transaction and enter the correct one.
- Do not close a fiscal year until finance and audit checks are complete.

---

# Part 3 — What each role can do

| Role | Main responsibility | Can change records? |
|---|---|---|
| Administrator | Full setup, users, configuration, approvals, year close, oversight | Yes, across the system |
| Treasurer | Expenses, income, accounts, reconciliation, budget preparation, finance oversight | Yes, finance only |
| Finance Secretary | Income, member dues, categories, welfare splits, fiscal-year preparation | Yes, selected finance areas |
| Secretary | Member register, ranks, positions, events, attendance | Yes, membership and secretary areas |
| Trustee | Independent annual audit and review of supporting evidence | Audit records only; cannot alter the books |
| Auditor | Independent annual audit, audit trail, and reconciliation review | Audit records only; cannot alter the books |
| President | Executive oversight, member information, events, finance and reports | Mainly read-only |
| First Vice President | Executive oversight and permitted member information | Read-only |
| Second Vice President | Executive oversight and permitted member information | Read-only |
| Commander | Executive oversight and permitted member information | Read-only |
| Executive | General dashboard, member directory, finance, budget, and reports | Read-only |
| Viewer | General read access plus dues and reconciliation review | Read-only |

### Important separation of duties

- The **Finance Secretary** can record income but cannot record expenses.
- The **Treasurer** can prepare a budget, but only the **Administrator** can approve, reopen, or close controlled periods.
- The **Secretary** maintains membership and attendance but does not manage financial entries.
- **Trustees and Auditors** conduct the independent review; they cannot create or change ordinary financial entries.
- Presidents and other executive roles see information for oversight but normally do not post transactions.

---

# Part 4 — Role-specific operating guides

## A. Administrator

### Daily or weekly

- Review `Dashboard` and `Finance → Overview` for unusual balances or overdue work.
- Review new users and deactivate accounts belonging to officers who have left office.
- Help users with password resets without asking for their old password.
- Review configuration requests before adding new accounts or categories.

### Reset a user's password

Path: `Administration → Users → Reset user password`

1. Select the user.
2. Enter a temporary password.
3. Select **Reset password**.
4. Give it privately to the user and require them to change it after signing in.

### Deactivate a user

Path: `Administration → Users`

Use the activate/deactivate icon beside the user. Prefer deactivation when the historical account should remain identifiable in the audit trail.

### Download a manual database backup

Path: `Administration → Download backup`  
Direct page: [Download backup](https://ksji825.tilcsaas.com/admin/backup)

Store the downloaded file securely. It contains sensitive financial and membership information. The server also performs scheduled encrypted S3 backups; the download is an extra administrator copy, not a replacement for the scheduled backup.

## B. Treasurer

### Record income

Path: `Finance → Income → Record Income`

1. Confirm the date is inside the active fiscal year.
2. Select the account that received the money.
3. Select the income category.
4. Enter the amount.
5. For an assessment payment, select the related member.
6. Enter the receipt/reference number and description.
7. Select **Save Income**.
8. Check that the entry appears as **Posted** in the income register.

### Record an expense

Path: `Finance → Expenses → Record Expense`

1. Enter the voucher/payment date.
2. Select the account the money was paid from.
3. Select the expense category.
4. Enter the amount.
5. Enter the voucher/reference number and description.
6. Select **Save Expense**.
7. Check that the account balance and expense register changed as expected.

### Transfer money between accounts

Direct page: [Transfer Money](https://ksji825.tilcsaas.com/finance/transfers)

1. Open `Finance → Transfers`.
2. Select the date and amount.
3. Under **Move from**, select the account the money left.
4. Under **Move to**, select the account that received the money.
5. Enter the deposit-slip/reference number and a useful description.
6. Select **Save Transfer**.
7. Confirm that the source balance fell and the destination balance rose by the same amount. Total commandery funds must not change.

To compare Treasurio with local records, use **Transfer register report** on the same page. Choose the start and end dates and select **View period**. Use **Download PDF** for a formal printable register or **Download CSV** for spreadsheet comparison. The report includes account direction, amount, reference, description, and status. The CSV also includes the recorder and timestamp. Reversed transfers remain visible for audit but are excluded from the posted total.

### Correct a posted transaction

Path: `Finance → Income` or `Finance → Expenses`

1. Find the transaction.
2. Use **Edit** only for description, reference, or reconciliation status.
3. If the date, account, category, member, or amount is wrong, select **Reverse**.
4. Enter a clear reason for the reversal.
5. Create a new correct transaction.

The original and reversal remain visible. This is deliberate and protects the audit trail.

### Reconcile an account

Path: `Finance → Reconciliation`  
Direct page: [Reconciliation](https://ksji825.tilcsaas.com/reconciliation)

Do this after receiving a bank/mobile money statement or completing a cash count.

1. Select the account.
2. Enter the statement period start and end dates.
3. Enter the closing statement or counted balance.
4. Add a note identifying the statement or count sheet.
5. Select **Save reconciliation**.
6. Review the displayed difference.
7. Investigate any non-zero difference; do not adjust the statement figure merely to force zero.

### Prepare the budget

Path: `Finance → Annual budget`

The treasurer can add and remove draft budget lines. When complete, ask the administrator to review and select **Approve and lock budget**.

### Monthly treasurer checklist

- [ ] All income is entered with references.
- [ ] All expenses are entered with vouchers/references and descriptions.
- [ ] Cash, bank, and mobile money accounts are reconciled.
- [ ] Reversals have clear reasons.
- [ ] Welfare collections and payouts use the correct categories.
- [ ] The monthly executive report has been reviewed.
- [ ] Budget variances have been explained to the executive.

## C. Finance Secretary

### Main responsibilities

- Record income and member payments.
- Maintain annual dues rules and approved member exceptions.
- Configure income/expense categories and welfare split rules with the administrator or treasurer.
- Open or activate fiscal years when formally instructed.
- Review member arrears and produce reports.

### Record one payment

Follow `Finance → Income → Record Income` using the same steps in the Treasurer section.

For assessment income, always select the member. Otherwise the payment will not reduce that member's assessment balance.

### Record several member payments together

Path: `Finance → Income → Batch Entry`  
Direct page: [Batch income](https://ksji825.tilcsaas.com/finance/income/batch)

1. Enter the common date, category, receiving account, and reference.
2. Enter an amount only beside each member who paid.
3. Leave other members blank.
4. Check all amounts carefully.
5. Select **Save All Payments** once.
6. Confirm the displayed count and total.

### Review arrears

Path: `Administration → Dues & rules`

Select **Export Arrears CSV** when a spreadsheet is required. Where SMS is configured and approved, reminders can be sent from the monthly report or SMS page.

## D. Secretary

### Maintain the member register

Path: `Overview → Members`

The secretary can add, edit, import, and update member records, including:

- Contact and personal information
- Membership status and reason
- Emergency contacts
- Rank history
- Degrees conferred
- Position history
- Transfer information

Use effective dates and supporting references. Do not delete a member merely because they have resigned, transferred, or been suspended; record a status change instead.

### Create an event

Path: `Secretary → Events & Attendance → New Event`  
Direct page: [New event](https://ksji825.tilcsaas.com/secretary/meetings/events/new)

1. Enter the event name and date.
2. Add the time if known.
3. Select level and type.
4. Enter the location.
5. Add a Google Drive minutes link if available.
6. Select **Create Event**.

### Mark attendance

1. Open `Secretary → Events & Attendance`.
2. Open the event.
3. Select **Mark Attendance**.
4. Mark every member **Present**, **Permission**, or **Absent**.
5. Select **Save Attendance**.

### Send an event reminder

Open the event and select **Send SMS Reminder**. Use this only when SMS has been configured and the event details are final.

### Manage event types

Path: `Secretary → Events & Attendance → Event Types`  
Direct page: [Event types](https://ksji825.tilcsaas.com/secretary/meetings/event-types)

Add or rename approved event types. Avoid duplicates such as “General Meeting” and “General Mtg”.

## E. Trustee or Auditor

The trustee/auditor reviews evidence independently. They should not use an administrator's or treasurer's account.

### Run the automated checks

Path: `Reports → Auto audit`  
Direct page: [Auto audit](https://ksji825.tilcsaas.com/auto-audit)

1. Select the required year.
2. Review Passed, Warnings, Failures, and the overall score.
3. Open the evidence under each warning or failure.
4. Remember that system checks do not replace physical inspection of vouchers, statements, minutes, procurement records, attendance, or assets.
5. Download the PDF for the audit file if required.

### Complete the trustee audit

Path: `Reports → Trustee audit`  
Direct page: [Trustee audit](https://ksji825.tilcsaas.com/trustee-audit)

1. Select the fiscal year and choose **View audit year**.
2. Select **Start annual audit**.
3. Review items requiring attention.
4. Review account balances, latest reconciliations, transaction evidence, and budget variance.
5. Use the transaction search to investigate selected periods, accounts, or reconciliation status.
6. Flag a transaction when follow-up is required and enter a clear reason.
7. Add investigation notes where necessary.
8. For every checklist item, select:
   - **Pass** — evidence is satisfactory.
   - **Exception** — a problem exists; notes are required in practice.
   - **Not applicable** — explain why it does not apply.
9. Do not leave checklist items as Pending.
10. Enter the overall audit conclusion.
11. Select **Complete and sign audit**.
12. Download the signed report, transactions CSV, and audit trail CSV for the audit file.

Once completed, the audit records who signed it and when.

### Review the system audit trail

Path: `Reports → Audit trail`  
Direct page: [Audit trail](https://ksji825.tilcsaas.com/audit)

Use **Review change** to inspect the reason, previous value, and new value where available. Export the audit log when a working spreadsheet is required.

## F. President, Vice Presidents, Commander, Executive, and Viewer

These roles are mainly for oversight.

### Recommended routine

1. Open **Dashboard** for the current position and recent activity.
2. Open `Finance → Overview` to review balances, income, expenses, and unreconciled work.
3. Open `Finance → Annual budget` to compare budget with actual figures.
4. Open `Reports → Financial reports` for the monthly executive report.
5. Open `Reports → Downloads` for formal PDF or CSV reports.
6. Open `Overview → Members` for the membership directory.

The President can also view events and attendance. President, vice presidents, and commander can see permitted emergency-contact information. Ordinary Executive users cannot see restricted emergency contacts.

The Viewer role additionally has read-only access to dues and reconciliation pages. It should be used for an officer who needs those specific control views but must not alter them.

---

# Part 5 — Reports and executive meetings

## Monthly executive report

Path: `Reports → Financial reports`  
Direct page: [Monthly report](https://ksji825.tilcsaas.com/reports)

1. Enter the year.
2. Select the month.
3. Select **View month**.
4. Review current balance, income, expenses, spendable balance, account reconciliations, welfare liability, category totals, running balance, and member arrears.
5. Select **Print** to print or save as PDF.
6. Select **Export CSV** when a spreadsheet is required.

## Formal downloads

Path: `Reports → Downloads`  
Direct page: [Downloads](https://ksji825.tilcsaas.com/download-reports)

Available in PDF or CSV:

- Income & Expenditure
- Receipts & Payments
- Welfare Fund
- Financial Position
- Individual Member Statement

Use PDF for signed meeting/audit packs and CSV for analysis.

## Suggested monthly meeting pack

- Monthly executive report
- Income & Expenditure report
- Receipts & Payments report
- Reconciliation summary
- Budget versus actual export
- Arrears list, where appropriate
- Explanations for reversals, large variances, or unreconciled differences

---

# Part 6 — Fiscal-year close and new year

Only the administrator can permanently close a year.

## Before closing

- [ ] All receipts and expenses are posted.
- [ ] Errors have been reversed and corrected.
- [ ] Every account is reconciled to the final statement or cash count.
- [ ] Welfare balances and liabilities are reviewed.
- [ ] Member arrears are checked.
- [ ] Budget versus actual has been reviewed.
- [ ] Automated audit findings are resolved or explained.
- [ ] Trustees/auditors have completed the annual audit.
- [ ] Required reports and backups have been saved.

## Close the year

Path: `Administration → Fiscal years`  
Direct page: [Fiscal years](https://ksji825.tilcsaas.com/fiscal-years)

1. Select the correct year under **Close a year**.
2. Enter a closing note.
3. Read the permanent-action warning.
4. Select **Close year permanently** and confirm.

Closing locks transactions and carries member balances forward. It cannot be undone through the normal interface.

## Open the next year

On the same page:

1. Enter the new year under **Open a new year**.
2. Select **Open year**.
3. Confirm it is marked **Active**.
4. Review copied dues rules and welfare splits.
5. Enter and approve the new budget.

---

# Part 7 — Common problems

## “I cannot see a button or page”

Your assigned role may not permit it. Ask the administrator to check `Administration → Users`. Do not use someone else's login.

## “The date is rejected”

The transaction date must fall inside the active, open fiscal year. Check the fiscal-year badge in the menu.

## “The member's arrears did not reduce”

Check that the income used a category whose purpose is **Member assessment** and that the correct member was selected.

## “Welfare is wrong”

Check the category purpose and the welfare split rule for that year. Do not change a historical rule that has already affected posted receipts; investigate with the administrator.

## “The account does not balance”

Do not force the reconciliation figure. Check missing transactions, duplicate entries, wrong accounts, reversed items, bank charges, and the statement period.

## “I entered the wrong amount”

Find the posted transaction, select **Reverse**, state the reason, and enter a new correct transaction.

## “I forgot my password”

Ask the administrator to use `Administration → Users → Reset user password`.

## “A page looks cramped on my phone”

Rotate the phone to landscape if reviewing a wide table. Forms and core records are responsive, but formal reports are easier to review on a larger screen or as PDF.

---

# Part 8 — Security and records discipline

- Each person must have an individual user account.
- Never share passwords or leave a shared device signed in.
- Deactivate departed users promptly.
- Give Administrator access only to people responsible for system control.
- Verify account and member opening balances against signed source records.
- Keep physical or approved digital receipts, vouchers, statements, minutes, and authorizations.
- Use reversal rather than deletion for incorrect financial entries.
- Record reasons whenever the system requests one.
- Treat database backups, exported member lists, arrears lists, and audit files as confidential.
- Report suspected unauthorized access immediately to the administrator and technical operator.

---

# Part 9 — Simple glossary

| Term | Meaning |
|---|---|
| Account | A place where money is held, such as cash, bank, or mobile money |
| Active fiscal year | The year currently used for new transactions and dues |
| Arrears | Money a member still owes |
| Audit trail | Permanent record of who performed an action and when |
| Budget variance | Actual amount minus budget amount |
| Category | The purpose or heading assigned to income or expense |
| Opening balance | Starting account or member balance at the agreed cut-off date |
| Posted | A transaction that has been entered into the books |
| Reconciled | Compared with an external statement or physical cash count |
| Reversal | An equal opposite entry used to cancel an incorrect posted transaction without hiding history |
| Spendable balance | Funds available after excluding welfare liability |
| Welfare liability | Welfare money collected but not yet paid out or otherwise settled |

---

## Handover record

When executive officers change, record:

- Date of handover
- Outgoing and incoming officer names
- Role assigned in Treasurio
- Date old access was deactivated
- Date new access was tested
- Last completed reconciliation
- Last completed monthly and annual reports
- Outstanding audit exceptions
- Confirmation that no password was shared between officers

The outgoing officer's user should normally be **deactivated**, not reused by the incoming officer.
