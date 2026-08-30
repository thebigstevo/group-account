'use strict';

const ROLE_LABELS = Object.freeze({
  admin: 'Administrator', president: 'President', first_vice_president: 'First Vice President',
  second_vice_president: 'Second Vice President', secretary: 'Secretary',
  finance_secretary: 'Finance Secretary', treasurer: 'Treasurer', commander: 'Commander',
  trustee: 'Trustee', executive: 'Executive', viewer: 'Read-only Viewer', auditor: 'Auditor'
});
const ALL_ROLES = Object.freeze(Object.keys(ROLE_LABELS));
const ROLE_START = Object.freeze({
  admin: 'Complete the setup topics first, then create named accounts for the other officers.',
  treasurer: 'Start with recording money, reconciliation, budgets, and reports.',
  finance_secretary: 'Start with income, member dues, categories, and reports.',
  secretary: 'Start with members, events, attendance, and reminders.',
  trustee: 'Start with the trustee audit workspace and financial reports.',
  auditor: 'Start with the audit workspace, reconciliation, and audit trail.',
  president: 'Start with dashboards, reports, budgets, members, and meeting records.',
  first_vice_president: 'Start with dashboards, reports, budgets, and member records.',
  second_vice_president: 'Start with dashboards, reports, budgets, and member records.',
  commander: 'Start with dashboards, reports, budgets, and member records.',
  executive: 'Start with dashboards, reports, budgets, and member records.',
  viewer: 'Use the read-only registers, reconciliation, budgets, and reports.'
});

const TOPICS = Object.freeze([
  {
    id: 'first-steps', title: 'First steps for every user',
    summary: 'Sign in safely, find the menu, choose the correct year, and sign out.', roles: ALL_ROLES,
    steps: [
      { text: 'Open the Treasurio address and enter your own email address and password.' },
      { text: 'On a phone, tap the three-line Menu button. On a computer, use the menu on the left.' },
      { text: 'Check the fiscal year shown at the top before entering or reviewing information.' },
      { text: 'Use Account to change your password. Use Sign out when you finish, especially on a shared device.', href: '/change-password', label: 'Open Account' }
    ],
    note: 'If a menu item is missing, your assigned role does not have permission to use it. Ask the administrator; do not borrow another user’s account.'
  },
  {
    id: 'fresh-installation', title: 'Administrator: fresh installation checklist',
    summary: 'The correct order for the first entries on a new system.', roles: ['admin'],
    steps: [
      { text: 'Gather the official organization details, opening year, accounts and balances, transaction categories, dues rules, member register, annual budget, and officer details.' },
      { text: 'On a completely new installation, open /setup. Create the first administrator, enter the organization name and currency, and open the first fiscal year.' },
      { text: 'Complete the organization profile and report signatories.', href: '/organization', label: 'Open Organization' },
      { text: 'Create every cash, bank, and mobile-money account using balances from one agreed cut-off date.', href: '/config', label: 'Open Settings' },
      { text: 'Create transaction categories and welfare split rules, then configure dues.', href: '/dues', label: 'Open Dues & rules' },
      { text: 'Add or import the members and check opening arrears or credits.', href: '/members/import', label: 'Import members' },
      { text: 'Enter the approved annual budget, check the totals, then approve and lock it.', href: '/budgets', label: 'Open Annual budget' },
      { text: 'Create one named user account for each officer and assign the minimum role they need.', href: '/users', label: 'Open Users' },
      { text: 'Before handover, compare account totals with source statements, test each role, run a report, and download a backup.', href: '/admin/backup', label: 'Download backup' }
    ],
    warning: 'Do not mix opening balances from different dates. Do not record live transactions until the opening figures and categories have been checked.'
  },
  {
    id: 'organization-settings', title: 'Administrator: organization and financial structure',
    summary: 'Set the identity, accounts, categories, welfare rules, ranks, and positions.', roles: ['admin'],
    steps: [
      { text: 'Under Organization, complete identity, contact details, letterhead, report signatories, and SMS settings.', href: '/organization', label: 'Open Organization' },
      { text: 'Under Settings, add each account with a clear unique name, correct type, and verified opening balance.', href: '/config', label: 'Open Settings' },
      { text: 'For each category choose Income, Expense, or Income & expense. Use Income & expense when the same purpose can receive and pay out money.' },
      { text: 'Choose the accounting purpose: Standard, Member assessment, Welfare collection, or Welfare payout.' },
      { text: 'Add welfare split rules only when an assessment receipt contains a welfare portion.' },
      { text: 'Add the official rank names used in member histories.', href: '/config/ranks', label: 'Manage ranks' },
      { text: 'Add official executive or service positions.', href: '/config/positions', label: 'Manage positions' }
    ],
    note: 'Avoid duplicate categories with slightly different spellings; they split the figures across reports.'
  },
  {
    id: 'users-and-security', title: 'Administrator: users and permissions',
    summary: 'Create, change, deactivate, and reset user accounts safely.', roles: ['admin'],
    steps: [
      { text: 'Open Users and select Add user.', href: '/users', label: 'Open Users' },
      { text: 'Enter the officer’s real name and an email address they control.' },
      { text: 'Assign the role matching the officer’s actual duty. Do not give Administrator merely for convenience.' },
      { text: 'Give the temporary password privately and ask the officer to change it after signing in.' },
      { text: 'Use Reset password if access is lost. Deactivate an account immediately when an officer leaves the role.' },
      { text: 'Review the user list whenever executives change and at least once each year.' }
    ],
    warning: 'Every person must use a separate account. Shared accounts weaken the audit trail because the system cannot identify who performed an action.'
  },
  {
    id: 'members', title: 'Members, ranks, positions, and opening arrears',
    summary: 'Maintain an accurate member register without losing history.', roles: ['admin', 'secretary'],
    steps: [
      { text: 'Open Members. Search before creating a record to avoid duplicates.', href: '/members', label: 'Open Members' },
      { text: 'For one person, select Add Member, enter the known details, and save.' },
      { text: 'Open the member profile to record status, rank, degree, position, transfer, and emergency contacts.' },
      { text: 'For many people, use Import register. Keep membership numbers in correction files so records match correctly.', href: '/members/import', label: 'Import register' },
      { text: 'Use positive opening arrears when the member owes money, a negative amount for credit, and zero for neither.' },
      { text: 'Read the import result and investigate every skipped or ambiguous row.' }
    ],
    warning: 'Do not delete a person merely because they left. Change their status so the membership history remains available.'
  },
  {
    id: 'dues', title: 'Annual dues and member assessments',
    summary: 'Set annual rules, approved exceptions, and review member balances.',
    roles: ['admin', 'finance_secretary', 'treasurer', 'auditor', 'viewer'],
    steps: [
      { text: 'Open Dues & rules and confirm the selected fiscal year.', href: '/dues', label: 'Open Dues & rules' },
      { text: 'Administrators and Finance Secretaries: add non-overlapping age rules with the total assessment and welfare portion.' },
      { text: 'Use a member override only for an approved exception, and record the reason.' },
      { text: 'Review each member’s opening balance, amount due, amount paid, and remaining balance.' },
      { text: 'Use reports to follow up overdue balances; confirm corrections against receipts before changing data.' }
    ],
    note: 'Rules become protected after qualifying payments are posted so past member balances cannot silently change.'
  },
  {
    id: 'record-income', title: 'Record income',
    summary: 'Enter receipts against the correct account, category, member, and evidence.',
    roles: ['admin', 'finance_secretary', 'treasurer'],
    steps: [
      { text: 'Choose Finance → Income → Record Income.', href: '/finance/income/new', label: 'Record Income' },
      { text: 'Enter the receipt date and select the account where the money was actually received.' },
      { text: 'Select the category. For an assessment, select the related member so their balance is reduced.' },
      { text: 'Enter the exact amount, receipt/reference number, and a useful description.' },
      { text: 'Save once, then check the new entry in the Income register.', href: '/finance/income', label: 'View Income' },
      { text: 'Attach a scan or photo of the receipt or deposit evidence from the transaction record when available.' }
    ],
    warning: 'Do not record money until it has actually been received. Check the account and member carefully before saving.'
  },
  {
    id: 'record-expense', title: 'Record an expense or transfer',
    summary: 'Enter payments, internal transfers, and supporting vouchers correctly.', roles: ['admin', 'treasurer'],
    steps: [
      { text: 'For a payment to an external person or organization, choose Finance → Expenses → Record Expense.', href: '/finance/expenses/new', label: 'Record Expense' },
      { text: 'Select the account the money left, choose the category, and enter the exact amount.' },
      { text: 'Add the voucher/reference number and explain what was paid for.' },
      { text: 'Save and attach the invoice, receipt, authorization, or voucher where available.' },
      { text: 'For money moved between your own accounts, use a Transfer—not an income and an expense.', href: '/transactions', label: 'Open Transactions' },
      { text: 'If a posted entry is wrong, reverse it and record the correct entry. Do not disguise corrections.' }
    ],
    warning: 'Confirm approval and available funds before paying. A transfer must not change total funds.'
  },
  {
    id: 'reconciliation', title: 'Reconcile cash, bank, and mobile money',
    summary: 'Compare Treasurio with independent statements and explain differences.',
    roles: ['admin', 'treasurer', 'auditor', 'viewer'],
    steps: [
      { text: 'Obtain the bank statement, mobile-money statement, or signed cash count for the period.' },
      { text: 'Choose Finance → Reconciliation and select the correct account and statement date.', href: '/finance/reconciliation', label: 'Open Reconciliation' },
      { text: 'Enter the independent closing balance and compare it with Treasurio’s balance.' },
      { text: 'Investigate every difference. Check missing transactions, wrong accounts, duplicate entries, and timing items.' },
      { text: 'Treasurers or administrators save the reconciliation and supporting notes. Auditors and viewers review it.' }
    ],
    warning: 'Do not force the statement balance to match. The purpose is to find and document genuine differences.'
  },
  {
    id: 'budget', title: 'Annual budget and actual results',
    summary: 'Enter the approved plan and compare it with what actually happened.', roles: ALL_ROLES,
    steps: [
      { text: 'Choose Finance → Annual budget and select the correct year.', href: '/budgets', label: 'Open Annual budget' },
      { text: 'Administrators and Treasurers: enter one amount for each planned income and expense category.' },
      { text: 'Check totals and notes. The Administrator approves and locks the agreed budget.' },
      { text: 'During the year, review Actual and Variance. Investigate important overspending or income shortfalls.' },
      { text: 'Use the budget-versus-actual export for executive meetings and year-end review.' }
    ],
    note: 'A favourable or unfavourable variance needs context; read whether the category is income or expense before drawing a conclusion.'
  },
  {
    id: 'leadership-review', title: 'Executive and read-only review',
    summary: 'Use dashboards and reports for oversight without changing the accounting records.',
    roles: ['president', 'first_vice_president', 'second_vice_president', 'commander', 'executive', 'viewer'],
    steps: [
      { text: 'Begin on the Dashboard and review balances, current activity, overdue dues, and work requiring attention.', href: '/', label: 'Open Dashboard' },
      { text: 'Open Members to find an individual and review the information your role is permitted to see.', href: '/members', label: 'Open Members' },
      { text: 'Open Annual budget to compare approved plans with actual income and spending.', href: '/budgets', label: 'Review Annual budget' },
      { text: 'Open Financial reports and confirm the selected fiscal year and month before interpreting figures.', href: '/finance/reports', label: 'Open Financial reports' },
      { text: 'Raise questions with the responsible officer. Do not ask for another person’s account to make a change outside your role.' }
    ],
    note: 'Read-only access is a governance control, not a limitation to work around. It preserves separation between recording, approval, and review.'
  },
  {
    id: 'secretary-work', title: 'Secretary: events, attendance, and reminders',
    summary: 'Create meetings or events, take attendance, and keep records complete.',
    roles: ['admin', 'secretary', 'president', 'trustee'],
    steps: [
      { text: 'Choose Secretary → Events & Attendance.', href: '/secretary/meetings', label: 'Open Events & Attendance' },
      { text: 'Administrators and Secretaries: create the event with the correct type, date, time, location, and description.' },
      { text: 'Open the event and record attendance promptly. Review the totals before leaving the page.' },
      { text: 'Send reminders only after checking the event details, recipients, and SMS configuration.' },
      { text: 'Presidents and Trustees use the same area to review meeting and attendance records.' }
    ],
    note: 'Correct the event record rather than creating a second version of the same meeting.'
  },
  {
    id: 'audit', title: 'Trustee and auditor review',
    summary: 'Use evidence, exceptions, notes, and sign-off to audit the books.',
    roles: ['admin', 'trustee', 'auditor', 'treasurer'],
    steps: [
      { text: 'Begin with Auto audit to identify missing references, missing descriptions, unreconciled items, and other exceptions.', href: '/auto-audit', label: 'Run Auto audit' },
      { text: 'Open Trustee audit, select the year, and compare receipts, payments, balances, reconciliations, and budget variances.', href: '/trustee-audit', label: 'Open Trustee audit' },
      { text: 'Trustees or Auditors start the review, inspect transaction evidence and attachments, and add notes or flags.' },
      { text: 'Work through every checklist item. Mark it passed only when the evidence supports that conclusion.' },
      { text: 'Resolve or explain exceptions, record the overall conclusion, and complete and sign the audit.' },
      { text: 'Use Audit trail to verify who created, changed, reversed, approved, or reviewed records.', href: '/audit', label: 'Open Audit trail', roles: ['admin', 'trustee', 'auditor'] }
    ],
    warning: 'The Treasurer supplies explanations and evidence but Trustees or Auditors should make the independent review conclusion.'
  },
  {
    id: 'reports', title: 'Reports and downloads',
    summary: 'Review monthly performance and produce formal records for meetings or handover.', roles: ALL_ROLES,
    steps: [
      { text: 'Choose Reports → Financial reports, then select the year and month.', href: '/finance/reports', label: 'Open Financial reports' },
      { text: 'Check the account balances, income, expenses, welfare liability, running balance, and member arrears.' },
      { text: 'Use Print to print or save the report as a PDF. Use Export CSV for spreadsheet analysis.' },
      { text: 'Choose Reports → Downloads for formal income-and-expenditure, receipts-and-payments, welfare, financial-position, and member-statement reports.', href: '/download-reports', label: 'Open Downloads' },
      { text: 'Always check the selected period and report title before sharing a file.' }
    ]
  },
  {
    id: 'year-end', title: 'Fiscal year close and new-year opening',
    summary: 'Finish the old year safely and carry member balances into the next year.',
    roles: ['admin', 'finance_secretary', 'treasurer'],
    steps: [
      { text: 'Before closing: enter all known transactions, attach evidence, reconcile every account, review arrears, resolve audit flags, and approve final reports.' },
      { text: 'Download and retain the reports and a backup before closing.' },
      { text: 'Administrator: choose Administration → Fiscal years, select the correct year, add closing notes, and use Close year.', href: '/fiscal-years', label: 'Open Fiscal years' },
      { text: 'Read the warning carefully. Closing locks the year and carries member balances forward.' },
      { text: 'Open the new year, review copied dues and welfare rules, enter the new budget, and verify carried-forward balances before new transactions.' }
    ],
    warning: 'Closing a fiscal year cannot be undone through the application. Never close it merely to test the button.'
  },
  {
    id: 'safe-working', title: 'Safe working and common problems',
    summary: 'Protect the records and recover from ordinary user mistakes.', roles: ALL_ROLES,
    steps: [
      { text: 'Never share passwords or leave the application open on a shared device.' },
      { text: 'Check the date, fiscal year, account, category, member, amount, and reference before saving.' },
      { text: 'If Save is unavailable, complete every required field marked with an asterisk.' },
      { text: 'If a page is missing, ask the administrator to check your role. Do not use another person’s account.' },
      { text: 'If a figure looks wrong, compare the transaction register, source document, and reconciliation before adding another entry.' },
      { text: 'Report suspected unauthorized access immediately and ask the administrator to deactivate the affected account or reset its password.' }
    ]
  }
]);

function normalizeQuery(value) { return String(value || '').trim().toLocaleLowerCase('en'); }
function topicSearchText(topic) {
  return [topic.title, topic.summary, topic.note, topic.warning]
    .concat(topic.steps.map((step) => `${step.text} ${step.label || ''}`))
    .filter(Boolean).join(' ').toLocaleLowerCase('en');
}
function visibleSteps(topic, role) {
  return topic.steps.filter((step) => !step.roles || step.roles.includes(role));
}
function helpForRole(role, query = '') {
  const safeRole = Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? role : 'viewer';
  const search = normalizeQuery(query);
  const allowed = TOPICS.filter((topic) => topic.roles.includes(safeRole))
    .map((topic) => ({ ...topic, steps: visibleSteps(topic, safeRole) }));
  return {
    role: safeRole, roleLabel: ROLE_LABELS[safeRole], startMessage: ROLE_START[safeRole],
    topics: search ? allowed.filter((topic) => topicSearchText(topic).includes(search)) : allowed,
    totalTopics: allowed.length, query: String(query || '').trim()
  };
}

module.exports = { ALL_ROLES, ROLE_LABELS, TOPICS, helpForRole };
