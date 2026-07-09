const express = require('express');
const session = require('express-session');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const { port, sessionSecret, n8nApiToken, requireSecret, secureCookies } = require('./config');
const { db, audit } = require('./db');
const { verifyPassword, hashPassword } = require('./security');
const SQLiteSessionStore = require('./sessionStore');
const {
  accountBalances,
  arrearsReport,
  calculateWelfareComponent,
  currentYear,
  latestReconciliations,
  runningBalanceRows,
  reportSummary
} = require('./services');
const {
  exportTransactionsCsv,
  exportArrearsCsv,
  exportReportCsv,
  exportReconciliationsCsv,
  exportAuditLogCsv
} = require('./csvExport');
const { importMembers } = require('./importMembers');
const {
  incomeAndExpenditureReport,
  receiptsAndPaymentsReport,
  welfareFundReport,
  financialPositionReport,
  memberStatementReport
} = require('./downloadableReports');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:']
    }
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

if (requireSecret && sessionSecret === 'dev-secret-change-in-production') {
  throw new Error('SESSION_SECRET must be set in production');
}

app.use(session({
  store: new SQLiteSessionStore(db),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

function generateCsrfToken(session) {
  if (!session._csrf) session._csrf = crypto.randomBytes(24).toString('hex');
  return session._csrf;
}

function validateCsrf(req, res, next) {
  if (req.path.startsWith('/api/')) return next();
  if (req.path === '/members/import' && req.method === 'POST') return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const token = req.body._csrf || req.get('x-csrf-token') || '';
  if (!token || token !== req.session._csrf) {
    return res.status(403).render('error', { message: 'Form expired. Please go back and try again.' });
  }
  next();
}

app.use((req, res, next) => {
  res.locals.csrfToken = generateCsrfToken(req.session);
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.title = 'KSJI Accounts';
  res.locals.formatMoney = (value) => Number(value || 0).toLocaleString('en-GH', {
    style: 'currency',
    currency: 'GHS'
  });
  next();
});
app.use(validateCsrf);

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || req.socket.remoteAddress || null;
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function allow(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return res.status(403).render('error', { message: 'You do not have permission for this action.' });
    next();
  };
}

function apiToken(req, res, next) {
  const header = req.get('authorization') || '';
  if (header !== `Bearer ${n8nApiToken}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function isYearClosed(txDate) {
  const year = Number(String(txDate || '').slice(0, 4));
  if (!year) return false;
  const fy = db.prepare('SELECT status FROM fiscal_years WHERE year = ?').get(year);
  return fy && fy.status === 'closed';
}

function monthPeriod(year, month) {
  const selectedMonth = Number(month || new Date().getMonth() + 1);
  const start = new Date(Date.UTC(year, selectedMonth - 1, 1));
  const end = new Date(Date.UTC(year, selectedMonth, 0));
  const monthName = start.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return {
    month: selectedMonth,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    label: `${monthName} ${year}`
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts, please try again later.'
});

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', loginLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(req.body.email);
  if (!user || !verifyPassword(req.body.password, user.password_hash)) {
    audit(null, 'login_failed', 'user', null, req.body.email, { ip_address: getClientIp(req) });
    return res.status(401).render('login', { error: 'Invalid email or password.' });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  audit(user.id, 'login', 'user', user.id, user.email, { ip_address: getClientIp(req) });
  res.redirect('/');
});

app.post('/logout', requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireLogin, (req, res) => {
  const summary = reportSummary();
  const recent = db.prepare(`
    SELECT t.*, m.name AS member_name, a.name AS account_name
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.status = 'posted'
    ORDER BY t.tx_date DESC, t.id DESC
    LIMIT 8
  `).all();
  const memberCount = db.prepare("SELECT COUNT(*) AS count FROM members WHERE status = 'active'").get().count;
  const unreconciledCount = db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status = 'posted' AND reconciled = 0").get().count;
  const arrearsCount = arrearsReport(currentYear()).filter((row) => row.balance > 0).length;
  const lastReconciliation = db.prepare('SELECT MAX(period_end) AS date FROM reconciliations').get().date;
  res.render('dashboard', { summary, recent, memberCount, unreconciledCount, arrearsCount, lastReconciliation });
});

app.get('/members', requireLogin, (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY name').all();
  res.render('members', { members });
});

app.get('/members/import', allow('admin', 'finance_secretary'), (req, res) => {
  res.render('members_import', { result: null });
});

app.post('/members/import', allow('admin', 'finance_secretary'), (req, res) => {
  const chunks = [];
  let size = 0;
  const maxSize = 5 * 1024 * 1024;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxSize) {
      req.destroy();
      return res.status(413).render('error', { message: 'File too large. Maximum 5MB.' });
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const contentType = req.get('content-type') || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(400).render('members_import', { result: { imported: 0, skipped: 0, errors: ['Invalid upload. Please use the form.'] } });
    }
    const boundary = '--' + boundaryMatch[1];
    const parts = body.toString('binary').split(boundary).filter(p => p.trim() && p.trim() !== '--');

    let fileBuffer = null;
    let filename = '';

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd);
      const content = part.slice(headerEnd + 4).replace(/\r\n$/, '');

      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (filenameMatch) {
        filename = filenameMatch[1];
        fileBuffer = Buffer.from(content, 'binary');
      }
    }

    if (!fileBuffer || !filename) {
      return res.render('members_import', { result: { imported: 0, skipped: 0, errors: ['No file uploaded.'] } });
    }

    const ext = filename.split('.').pop().toLowerCase();
    if (!['csv', 'xlsx', 'xls', 'txt'].includes(ext)) {
      return res.render('members_import', { result: { imported: 0, skipped: 0, errors: ['Unsupported file type. Use .csv or .xlsx.'] } });
    }

    try {
      const result = importMembers(fileBuffer, filename, req.session.user.id);
      res.render('members_import', { result });
    } catch (err) {
      res.render('members_import', { result: { imported: 0, skipped: 0, errors: [err.message] } });
    }
  });
});

app.get('/members/:id/edit', allow('admin', 'finance_secretary'), (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(Number(req.params.id));
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });
  res.render('member_edit', { member });
});

app.post('/members', allow('admin', 'finance_secretary'), (req, res) => {
  const result = db.prepare(`
    INSERT INTO members (name, phone, dob, status, opening_arrears, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.body.name, req.body.phone || null, req.body.dob || null, req.body.status || 'active', Number(req.body.opening_arrears || 0), req.body.notes || null);
  audit(req.session.user.id, 'create', 'member', result.lastInsertRowid, req.body.name);
  res.redirect('/members');
});

app.post('/members/:id', allow('admin', 'finance_secretary'), (req, res) => {
  const result = db.prepare(`
    UPDATE members
    SET name = ?, phone = ?, dob = ?, status = ?, opening_arrears = ?, notes = ?
    WHERE id = ?
  `).run(
    req.body.name,
    req.body.phone || null,
    req.body.dob || null,
    req.body.status || 'active',
    Number(req.body.opening_arrears || 0),
    req.body.notes || null,
    Number(req.params.id)
  );
  if (result.changes === 0) return res.status(404).render('error', { message: 'Member not found.' });
  audit(req.session.user.id, 'update', 'member', Number(req.params.id), req.body.name);
  res.redirect('/members');
});

app.get('/change-password', requireLogin, (req, res) => {
  res.render('change_password', { error: null, success: null });
});

app.post('/change-password', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !verifyPassword(req.body.current_password, user.password_hash)) {
    return res.render('change_password', { error: 'Current password is incorrect.', success: null });
  }
  if (!req.body.new_password || req.body.new_password.length < 8) {
    return res.render('change_password', { error: 'New password must be at least 8 characters.', success: null });
  }
  if (req.body.new_password !== req.body.confirm_password) {
    return res.render('change_password', { error: 'New passwords do not match.', success: null });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.new_password), user.id);
  audit(user.id, 'password_change', 'user', user.id, user.email);
  res.render('change_password', { error: null, success: 'Password changed successfully.' });
});

app.get('/config', allow('admin', 'finance_secretary', 'treasurer'), (req, res) => {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all();
  const splits = db.prepare('SELECT * FROM payment_splits ORDER BY year DESC, category').all();
  const rules = db.prepare('SELECT * FROM dues_rules ORDER BY year DESC, min_age').all();
  const categories = db.prepare('SELECT * FROM transaction_categories ORDER BY kind, sort_order, name').all();
  res.render('config', { accounts, splits, rules, categories, year: currentYear() });
});

app.post('/config/payment-splits', allow('admin', 'finance_secretary'), (req, res) => {
  db.prepare(`
    INSERT INTO payment_splits (year, category, assessment_amount, welfare_amount, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(year, category) DO UPDATE SET
      assessment_amount = excluded.assessment_amount,
      welfare_amount = excluded.welfare_amount,
      active = 1
  `).run(
    Number(req.body.year),
    req.body.category,
    Number(req.body.assessment_amount || 0),
    Number(req.body.welfare_amount || 0)
  );
  audit(req.session.user.id, 'upsert', 'payment_split', null, `${req.body.year} ${req.body.category}`);
  res.redirect('/config');
});

app.post('/config/accounts', allow('admin', 'treasurer'), (req, res) => {
  const result = db.prepare('INSERT INTO accounts (name, type, opening_balance) VALUES (?, ?, ?)').run(
    req.body.name,
    req.body.type,
    Number(req.body.opening_balance || 0)
  );
  audit(req.session.user.id, 'create', 'account', result.lastInsertRowid, req.body.name);
  res.redirect('/config');
});

app.post('/config/accounts/:id', allow('admin', 'treasurer'), (req, res) => {
  db.prepare(`
    UPDATE accounts
    SET name = ?, opening_balance = ?, active = ?
    WHERE id = ?
  `).run(
    req.body.name,
    Number(req.body.opening_balance || 0),
    req.body.active ? 1 : 0,
    Number(req.params.id)
  );
  audit(req.session.user.id, 'update', 'account', Number(req.params.id), req.body.name);
  res.redirect('/config');
});

app.post('/config/categories', allow('admin', 'finance_secretary', 'treasurer'), (req, res) => {
  db.prepare(`
    INSERT INTO transaction_categories (name, kind, active, sort_order)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(name) DO UPDATE SET
      kind = excluded.kind,
      active = 1,
      sort_order = excluded.sort_order
  `).run(req.body.name, req.body.kind, Number(req.body.sort_order || 100));
  audit(req.session.user.id, 'upsert', 'transaction_category', null, `${req.body.kind}: ${req.body.name}`);
  res.redirect('/config');
});

app.get('/fiscal-years', allow('admin', 'finance_secretary', 'treasurer'), (req, res) => {
  const years = db.prepare('SELECT * FROM fiscal_years ORDER BY year DESC').all();
  const currentYearValue = currentYear();
  const currentYearExists = years.some(y => y.year === currentYearValue);
  res.render('fiscal_years', { years, currentYear: currentYearValue, currentYearExists });
});

app.post('/fiscal-years/open', allow('admin', 'finance_secretary'), (req, res) => {
  const year = Number(req.body.year);
  if (!year || year < 2000 || year > 2100) {
    return res.status(400).render('error', { message: 'Invalid year.' });
  }

  const existing = db.prepare('SELECT * FROM fiscal_years WHERE year = ?').get(year);
  if (existing) {
    return res.status(400).render('error', { message: `Year ${year} is already ${existing.status}.` });
  }

  db.prepare('INSERT INTO fiscal_years (year, status) VALUES (?, \'open\')').run(year);

  // Copy dues rules from previous year if none exist for this year
  const rulesExist = db.prepare('SELECT COUNT(*) AS count FROM dues_rules WHERE year = ?').get(year).count;
  if (rulesExist === 0) {
    const prevRules = db.prepare('SELECT * FROM dues_rules WHERE year = ? AND active = 1').all(year - 1);
    const insertRule = db.prepare('INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion) VALUES (?, ?, ?, ?, ?, ?)');
    prevRules.forEach(r => insertRule.run(year, r.label, r.min_age, r.max_age, r.annual_assessment, r.welfare_portion));
  }

  // Copy payment splits from previous year if none exist
  const splitsExist = db.prepare('SELECT COUNT(*) AS count FROM payment_splits WHERE year = ?').get(year).count;
  if (splitsExist === 0) {
    const prevSplits = db.prepare('SELECT * FROM payment_splits WHERE year = ? AND active = 1').all(year - 1);
    const insertSplit = db.prepare('INSERT INTO payment_splits (year, category, assessment_amount, welfare_amount) VALUES (?, ?, ?, ?)');
    prevSplits.forEach(s => insertSplit.run(year, s.category, s.assessment_amount, s.welfare_amount));
  }

  audit(req.session.user.id, 'open', 'fiscal_year', year, `Opened year ${year}`);
  res.redirect('/fiscal-years');
});

app.post('/fiscal-years/close', allow('admin'), (req, res) => {
  const year = Number(req.body.year);
  const fy = db.prepare('SELECT * FROM fiscal_years WHERE year = ?').get(year);
  if (!fy || fy.status !== 'open') {
    return res.status(400).render('error', { message: `Year ${year} is not open.` });
  }

  // Calculate closing arrears for each active member and carry forward
  const members = db.prepare('SELECT * FROM members WHERE status = \'active\'').all();
  const arrears = require('./services').arrearsReport(year);

  const updateArrears = db.prepare('UPDATE members SET opening_arrears = ? WHERE id = ?');
  const closeYear = db.transaction(() => {
    arrears.forEach(row => {
      // New opening arrears = outstanding balance at year end (min 0 — overpayments don't carry as credit)
      const carryForward = Math.max(0, row.balance);
      updateArrears.run(carryForward, row.member_id);
    });

    db.prepare('UPDATE fiscal_years SET status = \'closed\', closed_at = CURRENT_TIMESTAMP, closed_by = ?, notes = ? WHERE year = ?')
      .run(req.session.user.id, req.body.notes || null, year);
  });

  closeYear();
  audit(req.session.user.id, 'close', 'fiscal_year', year, `Closed year ${year}. Arrears carried forward for ${arrears.length} members.`);
  res.redirect('/fiscal-years');
});

app.get('/dues', allow('admin', 'finance_secretary', 'treasurer', 'auditor', 'viewer'), (req, res) => {
  const rules = db.prepare('SELECT * FROM dues_rules ORDER BY year DESC, min_age').all();
  const members = db.prepare('SELECT id, name FROM members ORDER BY name').all();
  const overrides = db.prepare(`
    SELECT md.*, m.name
    FROM member_dues md
    JOIN members m ON m.id = md.member_id
    ORDER BY md.year DESC, m.name
  `).all();
  res.render('dues', { rules, members, overrides, year: currentYear() });
});

app.post('/dues/rules', allow('admin', 'finance_secretary'), (req, res) => {
  const result = db.prepare(`
    INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Number(req.body.year),
    req.body.label,
    req.body.min_age === '' ? null : Number(req.body.min_age),
    req.body.max_age === '' ? null : Number(req.body.max_age),
    Number(req.body.annual_assessment || 0),
    Number(req.body.welfare_portion || 0)
  );
  audit(req.session.user.id, 'create', 'dues_rule', result.lastInsertRowid, req.body.label);
  res.redirect('/dues');
});

app.post('/dues/overrides', allow('admin', 'finance_secretary'), (req, res) => {
  db.prepare(`
    INSERT INTO member_dues (member_id, year, assessment_due, welfare_portion, reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(member_id, year) DO UPDATE SET
      assessment_due = excluded.assessment_due,
      welfare_portion = excluded.welfare_portion,
      reason = excluded.reason
  `).run(
    Number(req.body.member_id),
    Number(req.body.year),
    Number(req.body.assessment_due || 0),
    Number(req.body.welfare_portion || 0),
    req.body.reason || null
  );
  audit(req.session.user.id, 'upsert', 'member_due', Number(req.body.member_id), String(req.body.year));
  res.redirect('/dues');
});

app.get('/transactions', requireLogin, (req, res) => {
  const transactions = db.prepare(`
    SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    ORDER BY t.tx_date DESC, t.id DESC
    LIMIT 100
  `).all();
  const members = db.prepare('SELECT id, name FROM members WHERE status = ? ORDER BY name').all('active');
  const accounts = db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all();
  const incomeCategories = db.prepare("SELECT name FROM transaction_categories WHERE active = 1 AND kind = 'income' ORDER BY sort_order, name").all();
  const expenseCategories = db.prepare("SELECT name FROM transaction_categories WHERE active = 1 AND kind = 'expense' ORDER BY sort_order, name").all();
  res.render('transactions', { transactions, members, accounts, incomeCategories, expenseCategories });
});

app.post('/transactions/receipt', allow('admin', 'finance_secretary', 'treasurer'), (req, res) => {
  if (isYearClosed(req.body.tx_date)) return res.status(400).render('error', { message: 'That year is closed. No new transactions allowed.' });
  const amount = Number(req.body.amount || 0);
  const welfare = calculateWelfareComponent({
    memberId: req.body.member_id || null,
    category: req.body.category || 'Assessment',
    amount,
    txDate: req.body.tx_date,
    enteredWelfare: req.body.welfare_component
  });
  if (welfare > amount) return res.status(400).render('error', { message: 'Welfare component cannot exceed total amount received.' });
  const result = db.prepare(`
    INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, description, amount, welfare_component, created_by)
    VALUES (?, 'receipt', ?, ?, ?, ?, ?, ?, ?)
  `).run(req.body.tx_date, req.body.member_id || null, Number(req.body.account_id), req.body.category || 'Assessment', req.body.description || null, amount, welfare, req.session.user.id);
  audit(req.session.user.id, 'create', 'receipt', result.lastInsertRowid, `${req.body.category} ${amount}`);
  res.redirect('/transactions');
});

app.post('/transactions/expense', allow('admin', 'treasurer'), (req, res) => {
  if (isYearClosed(req.body.tx_date)) return res.status(400).render('error', { message: 'That year is closed. No new transactions allowed.' });
  const type = req.body.category === 'Welfare Payout' ? 'welfare_payout' : 'expense';
  const result = db.prepare(`
    INSERT INTO transactions (tx_date, tx_type, account_id, category, description, amount, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.body.tx_date, type, Number(req.body.account_id), req.body.category || 'General Expense', req.body.description || null, Number(req.body.amount || 0), req.session.user.id);
  audit(req.session.user.id, 'create', type, result.lastInsertRowid, `${req.body.category} ${req.body.amount}`);
  res.redirect('/transactions');
});

app.post('/transactions/transfer', allow('admin', 'treasurer'), (req, res) => {
  if (isYearClosed(req.body.tx_date)) return res.status(400).render('error', { message: 'That year is closed. No new transactions allowed.' });
  const result = db.prepare(`
    INSERT INTO transactions (tx_date, tx_type, account_id, to_account_id, category, description, amount, created_by)
    VALUES (?, 'transfer', ?, ?, 'Transfer', ?, ?, ?)
  `).run(req.body.tx_date, Number(req.body.account_id), Number(req.body.to_account_id), req.body.description || null, Number(req.body.amount || 0), req.session.user.id);
  audit(req.session.user.id, 'create', 'transfer', result.lastInsertRowid, req.body.amount);
  res.redirect('/transactions');
});

app.post('/transactions/:id/reverse', allow('admin', 'finance_secretary', 'treasurer'), (req, res) => {
  const txId = Number(req.params.id);
  const original = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!original || original.status !== 'posted') {
    return res.status(400).render('error', { message: 'Cannot reverse a transaction that is not posted.' });
  }
  if (isYearClosed(original.tx_date)) return res.status(400).render('error', { message: 'That year is closed. Transactions cannot be reversed.' });
  
  const reversalResult = db.prepare(`
    INSERT INTO transactions (tx_date, tx_type, member_id, account_id, to_account_id, category, description, amount, welfare_component, status, reversed_by, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reversed', ?, ?)
  `).run(
    original.tx_date,
    original.tx_type,
    original.member_id,
    original.account_id,
    original.to_account_id,
    original.category,
    `REVERSAL: ${original.description || ''}`,
    original.amount,
    original.welfare_component,
    txId,
    req.session.user.id
  );
  
  db.prepare('UPDATE transactions SET status = ?, reversed_by = ? WHERE id = ?').run('reversed', reversalResult.lastInsertRowid, txId);
  audit(req.session.user.id, 'reverse', 'transaction', txId, `Reversed by transaction ${reversalResult.lastInsertRowid}`);
  res.redirect('/transactions');
});

app.post('/transactions/:id/reconcile', allow('admin', 'finance_secretary', 'treasurer', 'auditor'), (req, res) => {
  const txId = Number(req.params.id);
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!tx) return res.status(404).render('error', { message: 'Transaction not found.' });
  
  const isReconciled = tx.reconciled ? 0 : 1;
  db.prepare('UPDATE transactions SET reconciled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(isReconciled, txId);
  audit(req.session.user.id, 'update', 'transaction', txId, `Reconciled: ${isReconciled ? 'Yes' : 'No'}`);
  res.redirect('/transactions');
});

app.get('/reconciliation', allow('admin', 'treasurer', 'auditor', 'viewer'), (req, res) => {
  const balances = accountBalances();
  const reconciliations = db.prepare(`
    SELECT r.*, a.name AS account_name
    FROM reconciliations r
    JOIN accounts a ON a.id = r.account_id
    ORDER BY r.period_end DESC, r.id DESC
  `).all();
  res.render('reconciliation', { balances, reconciliations });
});

app.post('/reconciliation', allow('admin', 'treasurer'), (req, res) => {
  const balances = accountBalances();
  const account = balances.find((item) => item.id === Number(req.body.account_id));
  const systemBalance = account ? account.balance : 0;
  const statementBalance = Number(req.body.statement_balance || 0);
  const result = db.prepare(`
    INSERT INTO reconciliations (account_id, period_start, period_end, statement_balance, system_balance, difference, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(req.body.account_id), req.body.period_start, req.body.period_end, statementBalance, systemBalance, statementBalance - systemBalance, req.body.notes || null, req.session.user.id);
  audit(req.session.user.id, 'create', 'reconciliation', result.lastInsertRowid, req.body.period_end);
  res.redirect('/reconciliation');
});

app.get('/reports', requireLogin, (req, res) => {
  const year = Number(req.query.year || currentYear());
  const period = monthPeriod(year, req.query.month);
  const summary = reportSummary(period.startDate, period.endDate);
  const arrears = arrearsReport(year);
  const incomeByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'
      AND tx_date >= ?
      AND tx_date <= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(period.startDate, period.endDate);
  const expensesByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'expense' AND status = 'posted'
      AND tx_date >= ?
      AND tx_date <= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(period.startDate, period.endDate);
  const runningRows = runningBalanceRows(period.startDate, period.endDate);
  const reconciliations = latestReconciliations(period.endDate);
  res.render('reports', {
    year,
    month: period.month,
    period,
    summary,
    arrears,
    incomeByCategory,
    expensesByCategory,
    runningRows,
    reconciliations
  });
});

app.get('/api/reports/member-arrears', apiToken, (req, res) => {
  const year = Number(req.query.year || currentYear());
  const rows = arrearsReport(year)
    .filter((row) => row.balance > 0)
    .map((row) => ({
      member: row.name,
      phone: row.phone,
      arrears: row.balance,
      message: `Dear Brother ${row.name}, your outstanding balance for ${year} is GHS ${row.balance.toFixed(2)}. Thank you.`
    }));
  res.json({ year, count: rows.length, rows });
});

app.get('/users', allow('admin'), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, active FROM users ORDER BY name').all();
  res.render('users', { users });
});

app.post('/users', allow('admin'), (req, res) => {
  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (?, ?, ?, ?)
  `).run(req.body.name, req.body.email, hashPassword(req.body.password), req.body.role);
  audit(req.session.user.id, 'create', 'user', result.lastInsertRowid, req.body.email);
  res.redirect('/users');
});

app.post('/users/:id/toggle', allow('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).render('error', { message: 'User not found.' });
  if (target.id === req.session.user.id) return res.status(400).render('error', { message: 'You cannot deactivate your own account.' });
  const newActive = target.active ? 0 : 1;
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(newActive, target.id);
  audit(req.session.user.id, 'update', 'user', target.id, `${target.email} active=${newActive}`);
  res.redirect('/users');
});

app.post('/users/:id/reset-password', allow('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).render('error', { message: 'User not found.' });
  if (!req.body.new_password || req.body.new_password.length < 8) {
    return res.status(400).render('error', { message: 'Password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.new_password), target.id);
  audit(req.session.user.id, 'password_reset', 'user', target.id, target.email);
  res.redirect('/users');
});

app.get('/audit', allow('admin', 'auditor'), (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, u.name AS user_name
    FROM audit_log l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC
    LIMIT 200
  `).all();
  res.render('audit', { rows });
});

// Downloadable reports page
app.get('/download-reports', requireLogin, (req, res) => {
  const members = db.prepare('SELECT id, name FROM members WHERE status = ? ORDER BY name').all('active');
  res.render('download_reports', { year: currentYear(), members });
});

// Downloadable report endpoints
app.get('/download/income-expenditure', requireLogin, (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const month = req.query.month ? Number(req.query.month) : null;
    let startDate, endDate, label;

    if (month) {
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0));
      startDate = start.toISOString().slice(0, 10);
      endDate = end.toISOString().slice(0, 10);
      label = `${start.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${year}`;
    } else {
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31`;
      label = `Full Year ${year}`;
    }

    const csv = incomeAndExpenditureReport(db, startDate, endDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Income-Expenditure-${label.replace(/\s+/g, '-')}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'download', 'income_expenditure', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Income & Expenditure report.' });
  }
});

app.get('/download/receipts-payments', requireLogin, (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const month = req.query.month ? Number(req.query.month) : null;
    let startDate, endDate, label;

    if (month) {
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0));
      startDate = start.toISOString().slice(0, 10);
      endDate = end.toISOString().slice(0, 10);
      label = `${start.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${year}`;
    } else {
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31`;
      label = `Full Year ${year}`;
    }

    const csv = receiptsAndPaymentsReport(db, startDate, endDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Receipts-Payments-${label.replace(/\s+/g, '-')}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'download', 'receipts_payments', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Receipts & Payments report.' });
  }
});

app.get('/download/welfare-fund', requireLogin, (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const month = req.query.month ? Number(req.query.month) : null;
    let startDate, endDate, label;

    if (month) {
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0));
      startDate = start.toISOString().slice(0, 10);
      endDate = end.toISOString().slice(0, 10);
      label = `${start.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${year}`;
    } else {
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31`;
      label = `Full Year ${year}`;
    }

    const csv = welfareFundReport(db, startDate, endDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Welfare-Fund-${label.replace(/\s+/g, '-')}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'download', 'welfare_fund', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Welfare Fund report.' });
  }
});

app.get('/download/financial-position', requireLogin, (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const month = req.query.month ? Number(req.query.month) : null;
    let asOfDate, label;

    if (month) {
      const end = new Date(Date.UTC(year, month, 0));
      asOfDate = end.toISOString().slice(0, 10);
      const start = new Date(Date.UTC(year, month - 1, 1));
      label = `${start.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${year}`;
    } else {
      asOfDate = `${year}-12-31`;
      label = `31 December ${year}`;
    }

    const csv = financialPositionReport(db, asOfDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Financial-Position-${asOfDate}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'download', 'financial_position', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Financial Position report.' });
  }
});

app.get('/download/member-statement', requireLogin, (req, res) => {
  try {
    const memberId = Number(req.query.member_id);
    const year = Number(req.query.year || currentYear());
    if (!memberId) return res.status(400).render('error', { message: 'Please select a member.' });

    const csv = memberStatementReport(db, memberId, year);
    if (!csv) return res.status(404).render('error', { message: 'Member not found.' });

    const member = db.prepare('SELECT name FROM members WHERE id = ?').get(memberId);
    const safeName = (member ? member.name : 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Member-Statement-${safeName}-${year}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'download', 'member_statement', memberId, `${year}`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate member statement.' });
  }
});

// CSV Export endpoints
app.get('/export/transactions', requireLogin, (req, res) => {
  try {
    const csv = exportTransactionsCsv(db, {
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'export', 'transactions', null, 'CSV export');
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export transactions.' });
  }
});

app.get('/export/arrears', allow('admin', 'finance_secretary', 'treasurer', 'auditor', 'viewer'), (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const csv = exportArrearsCsv(db, year);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="arrears-${year}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'export', 'arrears', null, `Year ${year}`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export arrears report.' });
  }
});

app.get('/export/report', requireLogin, (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const month = Number(req.query.month || new Date().getMonth() + 1);
    const monthPeriod = (y, m) => {
      const selectedMonth = Number(m);
      const start = new Date(Date.UTC(y, selectedMonth - 1, 1));
      const end = new Date(Date.UTC(y, selectedMonth, 0));
      return {
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10)
      };
    };
    const period = monthPeriod(year, month);
    const csv = exportReportCsv(db, period.startDate, period.endDate);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${year}-${String(month).padStart(2, '0')}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'export', 'report', null, `${year}-${month}`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export report.' });
  }
});

app.get('/export/reconciliations', allow('admin', 'treasurer', 'auditor', 'viewer'), (req, res) => {
  try {
    const csv = exportReconciliationsCsv(db);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliations-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'export', 'reconciliations', null, 'CSV export');
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export reconciliations.' });
  }
});

app.get('/export/audit-log', allow('admin', 'auditor'), (req, res) => {
  try {
    const limitDays = Number(req.query.days || 90);
    const csv = exportAuditLogCsv(db, limitDays);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    audit(req.session.user.id, 'export', 'audit_log', null, `Last ${limitDays} days`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export audit log.' });
  }
});

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

app.listen(port, () => {
  console.log(`KSJI Accounts running at http://localhost:${port}`);
});
