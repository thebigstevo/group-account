const express = require('express');
const session = require('express-session');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const config = require('./config');
const { port, sessionSecret, n8nApiToken, requireSecret, secureCookies, groupName, groupCurrency } = config;
const dal = require('./dal');
const { verifyPassword, hashPassword } = require('./security');
const { formatDate, formatDateTime } = require('./viewHelpers');
const pgSession = require('connect-pg-simple')(session);
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
  exportMemberCleanupCsv,
  exportReportCsv,
  exportReconciliationsCsv,
  exportAuditLogCsv
} = require('./csvExport');
const { importMembers, rollbackMemberImport } = require('./importMembers');
const {
  MEMBER_STATUSES,
  USER_ROLES,
  canEditMembership,
  canViewEmergencyContacts,
  memberValues,
  normalizePhone,
  validateMemberInput,
  validateStatusChange,
} = require('./memberDomain');
const {
  incomeAndExpenditureReport,
  receiptsAndPaymentsReport,
  welfareFundReport,
  financialPositionReport,
  memberStatementReport
} = require('./downloadableReports');

const app = express();

// Nginx is the only service that can reach the container's loopback-bound port.
// Trust exactly that proxy hop so rate limits and audit logs use the client IP.
app.set('trust proxy', 1);

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

// Health check endpoint (before rate limiter and auth)
app.get('/health', async (req, res) => {
  try {
    await dal.queryOne('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'unreachable' });
  }
});

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
  store: new pgSession({
    pool: dal.pool,
    tableName: 'sessions',
    pruneSessionInterval: 3600
  }),
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

// Session store error handling — respond HTTP 503 if session DB is unreachable
app.use((err, req, res, next) => {
  if (err && err.message && err.message.toLowerCase().includes('session')) {
    console.error('Session store error:', err.message);
    return res.status(503).render('error', { message: 'Service temporarily unavailable. Please try again later.' });
  }
  next(err);
});

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
  res.locals.title = 'Treasurio';
  res.locals.groupName = config.groupName;
  res.locals.groupCurrency = config.groupCurrency;
  res.locals.formatMoney = (value) => Number(value || 0).toLocaleString(undefined, {
    style: 'currency',
    currency: config.groupCurrency
  });
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  // Flash message mechanism: read from session and pass to locals, then clear
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
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

/**
 * Wrap an async route handler to catch errors and pass them to Express error handling.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function isYearClosed(txDate) {
  const year = Number(String(txDate || '').slice(0, 4));
  if (!year) return false;
  const fy = await dal.queryOne('SELECT status FROM fiscal_years WHERE year = $1', [year]);
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

app.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const user = await dal.queryOne('SELECT * FROM users WHERE email = $1 AND active = true', [req.body.email]);
  if (!user || !verifyPassword(req.body.password, user.password_hash)) {
    await dal.audit(null, 'login_failed', 'user', null, req.body.email, { ip_address: getClientIp(req) });
    return res.status(401).render('login', { error: 'Invalid email or password.', values: { email: req.body.email } });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  await dal.audit(user.id, 'login', 'user', user.id, user.email, { ip_address: getClientIp(req) });
  res.redirect('/');
}));

app.post('/logout', requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireLogin, asyncHandler(async (req, res) => {
  try {
    const summary = await reportSummary();
    const recent = await dal.query(`
      SELECT t.*, m.name AS member_name, a.name AS account_name
      FROM transactions t
      LEFT JOIN members m ON m.id = t.member_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.status = 'posted'
      ORDER BY t.tx_date DESC, t.id DESC
      LIMIT 10
    `);
    const memberCountRow = await dal.queryOne("SELECT COUNT(*) AS count FROM members WHERE status = 'active'");
    const memberCount = Number(memberCountRow.count);
    const unreconciledRow = await dal.queryOne("SELECT COUNT(*) AS count FROM transactions WHERE status = 'posted' AND reconciled = false");
    const unreconciledCount = Number(unreconciledRow.count);
    const arrearsData = await arrearsReport(currentYear());
    const arrearsCount = arrearsData.filter((row) => row.balance > 0).length;
    const lastRecRow = await dal.queryOne('SELECT MAX(period_end) AS date FROM reconciliations');
    const lastReconciliation = lastRecRow ? lastRecRow.date : null;
    res.render('dashboard', { summary, recent, memberCount, unreconciledCount, arrearsCount, lastReconciliation });
  } catch (err) {
    console.error('Dashboard data load error:', err.message);
    res.render('dashboard', {
      error: true,
      summary: { balances: [], income: 0, expenses: 0, welfareLiability: 0, spendableBalance: 0 },
      recent: [],
      memberCount: 0,
      unreconciledCount: 0,
      arrearsCount: 0,
      lastReconciliation: null
    });
  }
}));

app.get('/members', requireLogin, asyncHandler(async (req, res) => {
  const members = await dal.query('SELECT * FROM members ORDER BY name');
  res.render('members', { members, canEdit: canEditMembership(req.session.user.role) });
}));

async function loadMemberImportBatches() {
  return dal.query(`
    SELECT b.*, creator.name AS created_by_name, reverser.name AS reversed_by_name
    FROM member_import_batches b
    LEFT JOIN users creator ON creator.id = b.created_by
    LEFT JOIN users reverser ON reverser.id = b.reversed_by
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT 50
  `);
}

app.get('/members/import', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  res.render('members_import', { result: null, batches: await loadMemberImportBatches() });
}));

app.post('/members/import', allow('admin', 'secretary'), (req, res) => {
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

  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const contentType = req.get('content-type') || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(400).render('members_import', { result: { imported: 0, skipped: 0, errors: ['Invalid upload. Please use the form.'] }, batches: await loadMemberImportBatches() });
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
      return res.render('members_import', { result: { imported: 0, skipped: 0, errors: ['No file uploaded.'] }, batches: await loadMemberImportBatches() });
    }

    const ext = filename.split('.').pop().toLowerCase();
    if (!['csv', 'xlsx', 'xls', 'txt'].includes(ext)) {
      return res.render('members_import', { result: { imported: 0, skipped: 0, errors: ['Unsupported file type. Use .csv or .xlsx.'] }, batches: await loadMemberImportBatches() });
    }

    try {
      const result = await importMembers(fileBuffer, filename, req.session.user.id);
      res.render('members_import', { result, batches: await loadMemberImportBatches() });
    } catch (err) {
      res.render('members_import', { result: { imported: 0, skipped: 0, errors: [err.message] }, batches: await loadMemberImportBatches() });
    }
  });
});

app.post('/members/imports/:id/rollback', allow('admin'), asyncHandler(async (req, res) => {
  try {
    const result = await rollbackMemberImport(Number(req.params.id), req.session.user.id);
    req.session.flash = {
      type: 'success',
      message: `Import ${result.filename} was rolled back. ${result.affected} member records restored or removed.`
    };
  } catch (error) {
    req.session.flash = { type: 'error', message: error.message };
  }
  res.redirect('/members/import');
}));

app.get('/members/:id/edit', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const member = await dal.queryOne('SELECT * FROM members WHERE id = $1', [Number(req.params.id)]);
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });
  res.render('member_edit', { member });
}));

app.post('/members', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const validationErrors = validateMemberInput(req.body);
  if (validationErrors.length) {
    const members = await dal.query('SELECT * FROM members ORDER BY name');
    return res.status(400).render('members', { members, canEdit: true, errors: validationErrors, values: req.body });
  }
  const values = memberValues(req.body);
  const result = await dal.run(`
    INSERT INTO members (
      name, title, first_name, middle_name, last_name, preferred_name,
      phone, secondary_phone, email, dob, residential_address, parish,
      occupation, date_first_admitted, status, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',$15)
    RETURNING id, membership_number
  `, [
    values.name, values.title, values.first_name, values.middle_name, values.last_name,
    values.preferred_name, values.phone, values.secondary_phone, values.email, values.dob,
    values.residential_address, values.parish, values.occupation, values.date_first_admitted, values.notes
  ]);
  await dal.audit(req.session.user.id, 'create', 'member', result.rows[0].id, {
    membership_number: result.rows[0].membership_number,
    name: values.name,
  }, { ip_address: getClientIp(req), user_agent: req.get('user-agent'), after_value: values });
  req.session.flash = { type: 'success', message: 'Member added successfully.' };
  res.redirect(`/members/${result.rows[0].id}`);
}));

app.post('/members/:id', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const member = await dal.queryOne('SELECT * FROM members WHERE id = $1', [Number(req.params.id)]);
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });
  const validationErrors = validateMemberInput(req.body);
  if (validationErrors.length) return res.status(400).render('member_edit', { member, errors: validationErrors, values: req.body });
  const values = memberValues(req.body);
  const result = await dal.run(`
    UPDATE members
    SET name=$1, title=$2, first_name=$3, middle_name=$4, last_name=$5,
        preferred_name=$6, phone=$7, secondary_phone=$8, email=$9, dob=$10,
        residential_address=$11, parish=$12, occupation=$13,
        date_first_admitted=$14, notes=$15
    WHERE id=$16
  `, [
    values.name, values.title, values.first_name, values.middle_name, values.last_name,
    values.preferred_name, values.phone, values.secondary_phone, values.email, values.dob,
    values.residential_address, values.parish, values.occupation, values.date_first_admitted, values.notes,
    Number(req.params.id)
  ]);
  if (result.rowCount === 0) return res.status(404).render('error', { message: 'Member not found.' });
  await dal.audit(req.session.user.id, 'update', 'member', member.id, values.name, {
    ip_address: getClientIp(req), user_agent: req.get('user-agent'), before_value: member, after_value: values
  });
  req.session.flash = { type: 'success', message: 'Member updated successfully.' };
  res.redirect(`/members/${member.id}`);
}));

app.post('/members/:id/delete', allow('admin'), asyncHandler(async (req, res) => {
  const memberId = Number(req.params.id);
  try {
    const deletedName = await dal.transaction(async (client) => {
      const memberResult = await client.query('SELECT * FROM members WHERE id = $1 FOR UPDATE', [memberId]);
      const member = memberResult.rows[0];
      if (!member) throw new Error('Member not found.');
      const dependencyResult = await client.query(`
        SELECT
          (SELECT COUNT(*)::int FROM transactions WHERE member_id = $1) AS transactions,
          (SELECT COUNT(*)::int FROM member_dues WHERE member_id = $1) AS dues,
          (SELECT COUNT(*)::int FROM member_emergency_contacts WHERE member_id = $1) AS contacts
      `, [memberId]);
      const dependencies = dependencyResult.rows[0];
      if (dependencies.transactions || dependencies.dues || dependencies.contacts) {
        throw new Error('This member cannot be deleted because financial activity, dues, or emergency contacts are linked to the record. Correct the record or change its status instead.');
      }
      await dal.audit(req.session.user.id, 'delete', 'member', memberId,
        { reason: 'Membership data cleanup' }, { client, before_value: member });
      await client.query('DELETE FROM member_status_history WHERE member_id = $1', [memberId]);
      await client.query('DELETE FROM members WHERE id = $1', [memberId]);
      return member.name;
    });
    req.session.flash = { type: 'success', message: `${deletedName} was removed from the membership register.` };
    return res.redirect('/members');
  } catch (error) {
    req.session.flash = { type: 'error', message: error.message };
    return res.redirect(`/members/${memberId}`);
  }
}));

app.get('/members/:id', requireLogin, asyncHandler(async (req, res) => {
  const member = await dal.queryOne(`
    SELECT m.*, c.name AS commandery_name
    FROM members m JOIN commanderies c ON c.id = m.commandery_id
    WHERE m.id = $1
  `, [Number(req.params.id)]);
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });
  const statusHistory = await dal.query(`
    SELECT h.*, u.name AS changed_by_name
    FROM member_status_history h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.member_id = $1 ORDER BY h.effective_date DESC, h.id DESC
  `, [member.id]);
  const mayViewEmergency = canViewEmergencyContacts(req.session.user.role);
  const emergencyContacts = mayViewEmergency
    ? await dal.query('SELECT * FROM member_emergency_contacts WHERE member_id = $1 ORDER BY is_primary DESC, id', [member.id])
    : [];
  res.render('member_profile', {
    member, statusHistory, emergencyContacts, statuses: MEMBER_STATUSES,
    canEdit: canEditMembership(req.session.user.role), mayViewEmergency
  });
}));

app.post('/members/:id/status', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const member = await dal.queryOne('SELECT * FROM members WHERE id = $1', [Number(req.params.id)]);
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });
  const errors = validateStatusChange(member.status, req.body.status, req.body.reason, req.body.effective_date);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/members/${member.id}`);
  }
  await dal.transaction(async (client) => {
    await client.query('UPDATE members SET status = $1 WHERE id = $2', [req.body.status, member.id]);
    const history = await client.query(`
      INSERT INTO member_status_history (
        commandery_id, member_id, previous_status, new_status, effective_date,
        reason, supporting_reference, changed_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [member.commandery_id, member.id, member.status, req.body.status, req.body.effective_date,
      req.body.reason.trim(), req.body.supporting_reference || null, req.session.user.id]);
    await dal.audit(req.session.user.id, 'status_change', 'member', member.id, {
      previous_status: member.status, new_status: req.body.status, history_id: history.rows[0].id
    }, { client, ip_address: getClientIp(req), user_agent: req.get('user-agent'), reason: req.body.reason,
      before_value: { status: member.status }, after_value: { status: req.body.status } });
  });
  req.session.flash = { type: 'success', message: 'Membership status updated and recorded in history.' };
  res.redirect(`/members/${member.id}`);
}));

app.post('/members/:id/emergency-contacts', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const member = await dal.queryOne('SELECT id, commandery_id FROM members WHERE id = $1', [Number(req.params.id)]);
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });
  const name = String(req.body.name || '').trim();
  const relationship = String(req.body.relationship || '').trim();
  let primaryPhone;
  let secondaryPhone;
  try { primaryPhone = normalizePhone(req.body.primary_phone); } catch (error) {
    req.session.flash = { type: 'error', message: error.message };
    return res.redirect(`/members/${member.id}`);
  }
  try { secondaryPhone = normalizePhone(req.body.secondary_phone); } catch (error) {
    req.session.flash = { type: 'error', message: `Secondary ${error.message.toLowerCase()}` };
    return res.redirect(`/members/${member.id}`);
  }
  if (!name || !relationship || !primaryPhone) {
    req.session.flash = { type: 'error', message: 'Contact name, relationship, and primary phone are required.' };
    return res.redirect(`/members/${member.id}`);
  }
  const result = await dal.run(`
    INSERT INTO member_emergency_contacts (
      commandery_id, member_id, name, relationship, primary_phone, secondary_phone,
      address, notes, is_primary, created_by, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id
  `, [member.commandery_id, member.id, name, relationship, primaryPhone,
    secondaryPhone, req.body.address || null, req.body.notes || null,
    req.body.is_primary === 'on', req.session.user.id]);
  await dal.audit(req.session.user.id, 'create', 'member_emergency_contact', result.rows[0].id,
    { member_id: member.id, relationship }, { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Emergency contact added.' };
  res.redirect(`/members/${member.id}`);
}));

app.get('/change-password', requireLogin, (req, res) => {
  const success = (res.locals.flash && res.locals.flash.type === 'success') ? res.locals.flash.message : null;
  res.render('change_password', { error: null, success });
});

app.post('/change-password', requireLogin, asyncHandler(async (req, res) => {
  const user = await dal.queryOne('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
  if (!user || !verifyPassword(req.body.current_password, user.password_hash)) {
    return res.render('change_password', { error: 'Current password is incorrect.', success: null, errors: ['Current password is incorrect.'], values: req.body });
  }
  if (!req.body.new_password || req.body.new_password.length < 8) {
    return res.render('change_password', { error: 'New password must be at least 8 characters.', success: null, errors: ['New password must be at least 8 characters.'], values: req.body });
  }
  if (req.body.new_password !== req.body.confirm_password) {
    return res.render('change_password', { error: 'New passwords do not match.', success: null, errors: ['New passwords do not match.'], values: req.body });
  }
  await dal.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(req.body.new_password), user.id]);
  await dal.audit(user.id, 'password_change', 'user', user.id, user.email);
  req.session.flash = { type: 'success', message: 'Password changed successfully.' };
  res.redirect('/change-password');
}));

app.get('/config', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const accounts = await dal.query('SELECT * FROM accounts ORDER BY id');
  const splits = await dal.query('SELECT * FROM payment_splits ORDER BY year DESC, category');
  const rules = await dal.query('SELECT * FROM dues_rules ORDER BY year DESC, min_age');
  const categories = await dal.query('SELECT * FROM transaction_categories ORDER BY kind, sort_order, name');
  res.render('config', { accounts, splits, rules, categories, year: currentYear() });
}));

app.post('/config/payment-splits', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  await dal.run(`
    INSERT INTO payment_splits (year, category, assessment_amount, welfare_amount, active)
    VALUES ($1, $2, $3, $4, true)
    ON CONFLICT(year, category) DO UPDATE SET
      assessment_amount = EXCLUDED.assessment_amount,
      welfare_amount = EXCLUDED.welfare_amount,
      active = true
  `, [
    Number(req.body.year),
    req.body.category,
    Number(req.body.assessment_amount || 0),
    Number(req.body.welfare_amount || 0)
  ]);
  await dal.audit(req.session.user.id, 'upsert', 'payment_split', null, `${req.body.year} ${req.body.category}`);
  req.session.flash = { type: 'success', message: 'Payment split saved successfully.' };
  res.redirect('/config');
}));

app.post('/config/accounts', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    const accounts = await dal.query('SELECT * FROM accounts ORDER BY id');
    const splits = await dal.query('SELECT * FROM payment_splits ORDER BY year DESC, category');
    const rules = await dal.query('SELECT * FROM dues_rules ORDER BY year DESC, min_age');
    const categories = await dal.query('SELECT * FROM transaction_categories ORDER BY kind, sort_order, name');
    return res.status(400).render('config', { accounts, splits, rules, categories, year: currentYear(), errors: ['Account name is required.'], values: req.body });
  }
  const result = await dal.run(`
    INSERT INTO accounts (name, type, opening_balance) VALUES ($1, $2, $3)
    RETURNING id
  `, [
    req.body.name,
    req.body.type,
    Number(req.body.opening_balance || 0)
  ]);
  await dal.audit(req.session.user.id, 'create', 'account', result.rows[0].id, req.body.name);
  req.session.flash = { type: 'success', message: 'Account added successfully.' };
  res.redirect('/config');
}));

app.post('/config/accounts/:id', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  await dal.run(`
    UPDATE accounts
    SET name = $1, opening_balance = $2, active = $3
    WHERE id = $4
  `, [
    req.body.name,
    Number(req.body.opening_balance || 0),
    req.body.active ? true : false,
    Number(req.params.id)
  ]);
  await dal.audit(req.session.user.id, 'update', 'account', Number(req.params.id), req.body.name);
  req.session.flash = { type: 'success', message: 'Account updated successfully.' };
  res.redirect('/config');
}));

app.post('/config/categories', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    const accounts = await dal.query('SELECT * FROM accounts ORDER BY id');
    const splits = await dal.query('SELECT * FROM payment_splits ORDER BY year DESC, category');
    const rules = await dal.query('SELECT * FROM dues_rules ORDER BY year DESC, min_age');
    const categories = await dal.query('SELECT * FROM transaction_categories ORDER BY kind, sort_order, name');
    return res.status(400).render('config', { accounts, splits, rules, categories, year: currentYear(), errors: ['Category name is required.'], values: req.body });
  }
  await dal.run(`
    INSERT INTO transaction_categories (name, kind, active, sort_order)
    VALUES ($1, $2, true, $3)
    ON CONFLICT(name) DO UPDATE SET
      kind = EXCLUDED.kind,
      active = true,
      sort_order = EXCLUDED.sort_order
  `, [req.body.name, req.body.kind, Number(req.body.sort_order || 100)]);
  await dal.audit(req.session.user.id, 'upsert', 'transaction_category', null, `${req.body.kind}: ${req.body.name}`);
  req.session.flash = { type: 'success', message: 'Category saved successfully.' };
  res.redirect('/config');
}));

app.get('/fiscal-years', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
  const currentYearValue = currentYear();
  const currentYearExists = years.some(y => y.year === currentYearValue);
  res.render('fiscal_years', { years, currentYear: currentYearValue, currentYearExists });
}));

app.post('/fiscal-years/open', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  if (!year || year < 2000 || year > 2100) {
    const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
    return res.status(400).render('fiscal_years', { years, currentYear: currentYear(), errors: ['Invalid year. Must be between 2000 and 2100.'], values: req.body });
  }

  const existing = await dal.queryOne('SELECT * FROM fiscal_years WHERE year = $1', [year]);
  if (existing) {
    const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
    return res.status(400).render('fiscal_years', { years, currentYear: currentYear(), errors: [`Year ${year} is already ${existing.status}.`], values: req.body });
  }

  await dal.run("INSERT INTO fiscal_years (year, status) VALUES ($1, 'open')", [year]);

  // Copy dues rules from previous year if none exist for this year
  const rulesExistRow = await dal.queryOne('SELECT COUNT(*) AS count FROM dues_rules WHERE year = $1', [year]);
  if (Number(rulesExistRow.count) === 0) {
    const prevRules = await dal.query('SELECT * FROM dues_rules WHERE year = $1 AND active = true', [year - 1]);
    for (const r of prevRules) {
      await dal.run(
        'INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion) VALUES ($1, $2, $3, $4, $5, $6)',
        [year, r.label, r.min_age, r.max_age, r.annual_assessment, r.welfare_portion]
      );
    }
  }

  // Copy payment splits from previous year if none exist
  const splitsExistRow = await dal.queryOne('SELECT COUNT(*) AS count FROM payment_splits WHERE year = $1', [year]);
  if (Number(splitsExistRow.count) === 0) {
    const prevSplits = await dal.query('SELECT * FROM payment_splits WHERE year = $1 AND active = true', [year - 1]);
    for (const s of prevSplits) {
      await dal.run(
        'INSERT INTO payment_splits (year, category, assessment_amount, welfare_amount) VALUES ($1, $2, $3, $4)',
        [year, s.category, s.assessment_amount, s.welfare_amount]
      );
    }
  }

  await dal.audit(req.session.user.id, 'open', 'fiscal_year', year, `Opened year ${year}`);
  req.session.flash = { type: 'success', message: `Fiscal year ${year} opened successfully.` };
  res.redirect('/fiscal-years');
}));

app.post('/fiscal-years/close', allow('admin'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const fy = await dal.queryOne('SELECT * FROM fiscal_years WHERE year = $1', [year]);
  if (!fy || fy.status !== 'open') {
    const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
    return res.status(400).render('fiscal_years', { years, currentYear: currentYear(), errors: [`Year ${year} is not open.`], values: req.body });
  }

  // Calculate closing arrears for each active member and carry forward
  const arrears = await arrearsReport(year);

  await dal.transaction(async (client) => {
    for (const row of arrears) {
      // New opening arrears = outstanding balance at year end (min 0 — overpayments don't carry as credit)
      const carryForward = Math.max(0, row.balance);
      await client.query('UPDATE members SET opening_arrears = $1 WHERE id = $2', [carryForward, row.member_id]);
    }

    await client.query(
      "UPDATE fiscal_years SET status = 'closed', closed_at = NOW(), closed_by = $1, notes = $2 WHERE year = $3",
      [req.session.user.id, req.body.notes || null, year]
    );
  });

  await dal.audit(req.session.user.id, 'close', 'fiscal_year', year, `Closed year ${year}. Arrears carried forward for ${arrears.length} members.`);
  req.session.flash = { type: 'success', message: `Fiscal year ${year} closed. Arrears carried forward for ${arrears.length} members.` };
  res.redirect('/fiscal-years');
}));

app.get('/dues', allow('admin', 'finance_secretary', 'treasurer', 'auditor', 'viewer'), asyncHandler(async (req, res) => {
  const rules = await dal.query('SELECT * FROM dues_rules ORDER BY year DESC, min_age');
  const members = await dal.query('SELECT id, name FROM members ORDER BY name');
  const overrides = await dal.query(`
    SELECT md.*, m.name
    FROM member_dues md
    JOIN members m ON m.id = md.member_id
    ORDER BY md.year DESC, m.name
  `);
  res.render('dues', { rules, members, overrides, year: currentYear() });
}));

app.post('/dues/rules', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  if (!req.body.label || !req.body.label.trim()) {
    const rules = await dal.query('SELECT * FROM dues_rules ORDER BY year DESC, min_age');
    const members = await dal.query('SELECT id, name FROM members ORDER BY name');
    const overrides = await dal.query(`SELECT md.*, m.name FROM member_dues md JOIN members m ON m.id = md.member_id ORDER BY md.year DESC, m.name`);
    return res.status(400).render('dues', { rules, members, overrides, year: currentYear(), errors: ['Label is required.'], values: req.body });
  }
  const result = await dal.run(`
    INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [
    Number(req.body.year),
    req.body.label,
    req.body.min_age === '' ? null : Number(req.body.min_age),
    req.body.max_age === '' ? null : Number(req.body.max_age),
    Number(req.body.annual_assessment || 0),
    Number(req.body.welfare_portion || 0)
  ]);
  await dal.audit(req.session.user.id, 'create', 'dues_rule', result.rows[0].id, req.body.label);
  req.session.flash = { type: 'success', message: 'Dues rule added successfully.' };
  res.redirect('/dues');
}));

app.post('/dues/overrides', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  await dal.run(`
    INSERT INTO member_dues (member_id, year, assessment_due, welfare_portion, reason)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(member_id, year) DO UPDATE SET
      assessment_due = EXCLUDED.assessment_due,
      welfare_portion = EXCLUDED.welfare_portion,
      reason = EXCLUDED.reason
  `, [
    Number(req.body.member_id),
    Number(req.body.year),
    Number(req.body.assessment_due || 0),
    Number(req.body.welfare_portion || 0),
    req.body.reason || null
  ]);
  await dal.audit(req.session.user.id, 'upsert', 'member_due', Number(req.body.member_id), String(req.body.year));
  req.session.flash = { type: 'success', message: 'Member dues override saved.' };
  res.redirect('/dues');
}));

app.get('/transactions', requireLogin, asyncHandler(async (req, res) => {
  const transactions = await dal.query(`
    SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    ORDER BY t.tx_date DESC, t.id DESC
    LIMIT 100
  `);
  const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
  const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
  const incomeCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'income' ORDER BY sort_order, name");
  const expenseCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'expense' ORDER BY sort_order, name");
  res.render('transactions', { transactions, members, accounts, incomeCategories, expenseCategories });
}));

app.post('/transactions/receipt', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  if (await isYearClosed(req.body.tx_date)) {
    const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
    const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
    const incomeCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'income' ORDER BY sort_order, name");
    const expenseCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'expense' ORDER BY sort_order, name");
    const transactions = await dal.query(`SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id ORDER BY t.tx_date DESC, t.id DESC LIMIT 100`);
    return res.status(400).render('transactions', { transactions, members, accounts, incomeCategories, expenseCategories, errors: ['That year is closed. No new transactions allowed.'], values: req.body });
  }
  const amount = Number(req.body.amount || 0);
  const welfare = await calculateWelfareComponent({
    memberId: req.body.member_id || null,
    category: req.body.category || 'Assessment',
    amount,
    txDate: req.body.tx_date,
    enteredWelfare: req.body.welfare_component
  });
  if (welfare > amount) {
    const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
    const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
    const incomeCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'income' ORDER BY sort_order, name");
    const expenseCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'expense' ORDER BY sort_order, name");
    const transactions = await dal.query(`SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id ORDER BY t.tx_date DESC, t.id DESC LIMIT 100`);
    return res.status(400).render('transactions', { transactions, members, accounts, incomeCategories, expenseCategories, errors: ['Welfare component cannot exceed total amount received.'], values: req.body });
  }
  const result = await dal.run(`
    INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, description, amount, welfare_component, created_by)
    VALUES ($1, 'receipt', $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [req.body.tx_date, req.body.member_id || null, Number(req.body.account_id), req.body.category || 'Assessment', req.body.description || null, amount, welfare, req.session.user.id]);
  await dal.audit(req.session.user.id, 'create', 'receipt', result.rows[0].id, `${req.body.category} ${amount}`);
  req.session.flash = { type: 'success', message: 'Receipt saved successfully.' };
  res.redirect('/transactions');
}));

app.post('/transactions/expense', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  if (await isYearClosed(req.body.tx_date)) {
    const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
    const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
    const incomeCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'income' ORDER BY sort_order, name");
    const expenseCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'expense' ORDER BY sort_order, name");
    const transactions = await dal.query(`SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id ORDER BY t.tx_date DESC, t.id DESC LIMIT 100`);
    return res.status(400).render('transactions', { transactions, members, accounts, incomeCategories, expenseCategories, errors: ['That year is closed. No new transactions allowed.'], values: req.body });
  }
  const type = req.body.category === 'Welfare Payout' ? 'welfare_payout' : 'expense';
  const result = await dal.run(`
    INSERT INTO transactions (tx_date, tx_type, account_id, category, description, amount, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [req.body.tx_date, type, Number(req.body.account_id), req.body.category || 'General Expense', req.body.description || null, Number(req.body.amount || 0), req.session.user.id]);
  await dal.audit(req.session.user.id, 'create', type, result.rows[0].id, `${req.body.category} ${req.body.amount}`);
  req.session.flash = { type: 'success', message: 'Expense saved successfully.' };
  res.redirect('/transactions');
}));

app.post('/transactions/transfer', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  if (await isYearClosed(req.body.tx_date)) {
    const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
    const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
    const incomeCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'income' ORDER BY sort_order, name");
    const expenseCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind = 'expense' ORDER BY sort_order, name");
    const transactions = await dal.query(`SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id ORDER BY t.tx_date DESC, t.id DESC LIMIT 100`);
    return res.status(400).render('transactions', { transactions, members, accounts, incomeCategories, expenseCategories, errors: ['That year is closed. No new transactions allowed.'], values: req.body });
  }
  const result = await dal.run(`
    INSERT INTO transactions (tx_date, tx_type, account_id, to_account_id, category, description, amount, created_by)
    VALUES ($1, 'transfer', $2, $3, 'Transfer', $4, $5, $6)
    RETURNING id
  `, [req.body.tx_date, Number(req.body.account_id), Number(req.body.to_account_id), req.body.description || null, Number(req.body.amount || 0), req.session.user.id]);
  await dal.audit(req.session.user.id, 'create', 'transfer', result.rows[0].id, req.body.amount);
  req.session.flash = { type: 'success', message: 'Transfer saved successfully.' };
  res.redirect('/transactions');
}));

app.post('/transactions/:id/reverse', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const txId = Number(req.params.id);
  const original = await dal.queryOne('SELECT * FROM transactions WHERE id = $1', [txId]);
  if (!original || original.status !== 'posted') {
    return res.status(400).render('error', { message: 'Cannot reverse a transaction that is not posted.' });
  }
  if (await isYearClosed(original.tx_date)) return res.status(400).render('error', { message: 'That year is closed. Transactions cannot be reversed.' });

  const reversalResult = await dal.run(`
    INSERT INTO transactions (tx_date, tx_type, member_id, account_id, to_account_id, category, description, amount, welfare_component, status, reversed_by, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reversed', $10, $11)
    RETURNING id
  `, [
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
  ]);

  await dal.run('UPDATE transactions SET status = $1, reversed_by = $2 WHERE id = $3', ['reversed', reversalResult.rows[0].id, txId]);
  await dal.audit(req.session.user.id, 'reverse', 'transaction', txId, `Reversed by transaction ${reversalResult.rows[0].id}`);
  req.session.flash = { type: 'success', message: 'Transaction reversed successfully.' };
  res.redirect('/transactions');
}));

app.post('/transactions/:id/reconcile', allow('admin', 'finance_secretary', 'treasurer', 'auditor'), asyncHandler(async (req, res) => {
  const txId = Number(req.params.id);
  const tx = await dal.queryOne('SELECT * FROM transactions WHERE id = $1', [txId]);
  if (!tx) return res.status(404).render('error', { message: 'Transaction not found.' });

  const isReconciled = tx.reconciled ? false : true;
  await dal.run('UPDATE transactions SET reconciled = $1, updated_at = NOW() WHERE id = $2', [isReconciled, txId]);
  await dal.audit(req.session.user.id, 'update', 'transaction', txId, `Reconciled: ${isReconciled ? 'Yes' : 'No'}`);
  res.redirect('/transactions');
}));

app.get('/reconciliation', allow('admin', 'treasurer', 'auditor', 'viewer'), asyncHandler(async (req, res) => {
  const balances = await accountBalances();
  const reconciliations = await dal.query(`
    SELECT r.*, a.name AS account_name
    FROM reconciliations r
    JOIN accounts a ON a.id = r.account_id
    ORDER BY r.period_end DESC, r.id DESC
  `);
  res.render('reconciliation', { balances, reconciliations });
}));

app.post('/reconciliation', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const balances = await accountBalances();
  const account = balances.find((item) => item.id === Number(req.body.account_id));
  const systemBalance = account ? account.balance : 0;
  const statementBalance = Number(req.body.statement_balance || 0);
  const result = await dal.run(`
    INSERT INTO reconciliations (account_id, period_start, period_end, statement_balance, system_balance, difference, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [Number(req.body.account_id), req.body.period_start, req.body.period_end, statementBalance, systemBalance, statementBalance - systemBalance, req.body.notes || null, req.session.user.id]);
  await dal.audit(req.session.user.id, 'create', 'reconciliation', result.rows[0].id, req.body.period_end);
  req.session.flash = { type: 'success', message: 'Reconciliation saved successfully.' };
  res.redirect('/reconciliation');
}));

app.get('/reports', requireLogin, asyncHandler(async (req, res) => {
  const year = Number(req.query.year || currentYear());
  const period = monthPeriod(year, req.query.month);
  const summary = await reportSummary(period.startDate, period.endDate);
  const arrears = await arrearsReport(year);
  const incomeByCategory = await dal.query(`
    SELECT category, COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'
      AND tx_date >= $1
      AND tx_date <= $2
    GROUP BY category
    ORDER BY total DESC
  `, [period.startDate, period.endDate]);
  const expensesByCategory = await dal.query(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'expense' AND status = 'posted'
      AND tx_date >= $1
      AND tx_date <= $2
    GROUP BY category
    ORDER BY total DESC
  `, [period.startDate, period.endDate]);
  const runningRows = await runningBalanceRows(period.startDate, period.endDate);
  const reconciliations = await latestReconciliations(period.endDate);
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
}));

app.get('/api/reports/member-arrears', apiToken, asyncHandler(async (req, res) => {
  const year = Number(req.query.year || currentYear());
  const rows = (await arrearsReport(year))
    .filter((row) => row.balance > 0)
    .map((row) => ({
      member: row.name,
      phone: row.phone,
      arrears: row.balance,
      message: `Dear Brother ${row.name}, your outstanding balance for ${year} is GHS ${row.balance.toFixed(2)}. Thank you.`
    }));
  res.json({ year, count: rows.length, rows });
}));

app.get('/users', allow('admin'), asyncHandler(async (req, res) => {
  const users = await dal.query('SELECT id, name, email, role, active FROM users ORDER BY name');
  res.render('users', { users });
}));

app.post('/users', allow('admin'), asyncHandler(async (req, res) => {
  const validationErrors = [];
  if (!req.body.name || !req.body.name.trim()) validationErrors.push('Name is required.');
  if (!req.body.email || !req.body.email.trim()) validationErrors.push('Email is required.');
  if (!req.body.password || req.body.password.length < 8) validationErrors.push('Password must be at least 8 characters.');
  if (!USER_ROLES.includes(req.body.role)) validationErrors.push('Select a valid role.');

  if (validationErrors.length > 0) {
    const users = await dal.query('SELECT id, name, email, role, active FROM users ORDER BY name');
    return res.status(400).render('users', { users, errors: validationErrors, values: req.body });
  }

  const result = await dal.run(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [req.body.name, req.body.email, hashPassword(req.body.password), req.body.role]);
  await dal.audit(req.session.user.id, 'create', 'user', result.rows[0].id, req.body.email);
  req.session.flash = { type: 'success', message: 'User added successfully.' };
  res.redirect('/users');
}));

app.post('/users/:id/toggle', allow('admin'), asyncHandler(async (req, res) => {
  const target = await dal.queryOne('SELECT * FROM users WHERE id = $1', [Number(req.params.id)]);
  if (!target) return res.status(404).render('error', { message: 'User not found.' });
  if (target.id === req.session.user.id) return res.status(400).render('error', { message: 'You cannot deactivate your own account.' });
  const newActive = target.active ? false : true;
  await dal.run('UPDATE users SET active = $1 WHERE id = $2', [newActive, target.id]);
  await dal.audit(req.session.user.id, 'update', 'user', target.id, `${target.email} active=${newActive}`);
  res.redirect('/users');
}));

app.post('/users/:id/reset-password', allow('admin'), asyncHandler(async (req, res) => {
  const target = await dal.queryOne('SELECT * FROM users WHERE id = $1', [Number(req.params.id)]);
  if (!target) return res.status(404).render('error', { message: 'User not found.' });
  if (!req.body.new_password || req.body.new_password.length < 8) {
    const users = await dal.query('SELECT id, name, email, role, active FROM users ORDER BY name');
    return res.status(400).render('users', { users, errors: ['Password must be at least 8 characters.'], values: req.body });
  }
  await dal.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(req.body.new_password), target.id]);
  await dal.audit(req.session.user.id, 'password_reset', 'user', target.id, target.email);
  req.session.flash = { type: 'success', message: `Password reset for ${target.name}.` };
  res.redirect('/users');
}));

app.get('/audit', allow('admin', 'auditor'), asyncHandler(async (req, res) => {
  const rows = await dal.query(`
    SELECT l.*, u.name AS user_name
    FROM audit_log l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC
    LIMIT 200
  `);
  res.render('audit', { rows });
}));

// Downloadable reports page
app.get('/download-reports', requireLogin, asyncHandler(async (req, res) => {
  const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
  res.render('download_reports', { year: currentYear(), members });
}));

// Downloadable report endpoints
app.get('/download/income-expenditure', requireLogin, asyncHandler(async (req, res) => {
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

    const csv = await incomeAndExpenditureReport(startDate, endDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Income-Expenditure-${label.replace(/\s+/g, '-')}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'download', 'income_expenditure', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Income & Expenditure report.' });
  }
}));

app.get('/download/receipts-payments', requireLogin, asyncHandler(async (req, res) => {
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

    const csv = await receiptsAndPaymentsReport(startDate, endDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Receipts-Payments-${label.replace(/\s+/g, '-')}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'download', 'receipts_payments', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Receipts & Payments report.' });
  }
}));

app.get('/download/welfare-fund', requireLogin, asyncHandler(async (req, res) => {
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

    const csv = await welfareFundReport(startDate, endDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Welfare-Fund-${label.replace(/\s+/g, '-')}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'download', 'welfare_fund', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Welfare Fund report.' });
  }
}));

app.get('/download/financial-position', requireLogin, asyncHandler(async (req, res) => {
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

    const csv = await financialPositionReport(asOfDate, label);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Financial-Position-${asOfDate}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'download', 'financial_position', null, label);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate Financial Position report.' });
  }
}));

app.get('/download/member-statement', requireLogin, asyncHandler(async (req, res) => {
  try {
    const memberId = Number(req.query.member_id);
    const year = Number(req.query.year || currentYear());
    if (!memberId) return res.status(400).render('error', { message: 'Please select a member.' });

    const csv = await memberStatementReport(memberId, year);
    if (!csv) return res.status(404).render('error', { message: 'Member not found.' });

    const member = await dal.queryOne('SELECT name FROM members WHERE id = $1', [memberId]);
    const safeName = (member ? member.name : 'Unknown').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Member-Statement-${safeName}-${year}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'download', 'member_statement', memberId, `${year}`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).render('error', { message: 'Failed to generate member statement.' });
  }
}));

// CSV Export endpoints
app.get('/export/transactions', requireLogin, asyncHandler(async (req, res) => {
  try {
    const csv = await exportTransactionsCsv({
      startDate: req.query.startDate || null,
      endDate: req.query.endDate || null
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'export', 'transactions', null, 'CSV export');
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export transactions.' });
  }
}));

app.get('/export/arrears', allow('admin', 'finance_secretary', 'treasurer', 'auditor', 'viewer'), asyncHandler(async (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const csv = await exportArrearsCsv(year);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="arrears-${year}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'export', 'arrears', null, `Year ${year}`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export arrears report.' });
  }
}));

app.get('/export/members-cleanup', allow('admin'), asyncHandler(async (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const csv = await exportMemberCleanupCsv(year);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="member-cleanup-${year}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'export', 'member_cleanup', null, `Year ${year}`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export the member cleanup register.' });
  }
}));

app.get('/export/report', requireLogin, asyncHandler(async (req, res) => {
  try {
    const year = Number(req.query.year || currentYear());
    const month = Number(req.query.month || new Date().getMonth() + 1);
    const selectedMonth = Number(month);
    const start = new Date(Date.UTC(year, selectedMonth - 1, 1));
    const end = new Date(Date.UTC(year, selectedMonth, 0));
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);
    const csv = await exportReportCsv(startDate, endDate);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${year}-${String(month).padStart(2, '0')}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'export', 'report', null, `${year}-${month}`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export report.' });
  }
}));

app.get('/export/reconciliations', allow('admin', 'treasurer', 'auditor', 'viewer'), asyncHandler(async (req, res) => {
  try {
    const csv = await exportReconciliationsCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliations-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'export', 'reconciliations', null, 'CSV export');
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export reconciliations.' });
  }
}));

app.get('/export/audit-log', allow('admin', 'auditor'), asyncHandler(async (req, res) => {
  try {
    const limitDays = Number(req.query.days || 90);
    const csv = await exportAuditLogCsv(limitDays);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'export', 'audit_log', null, `Last ${limitDays} days`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export audit log.' });
  }
}));

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

app.listen(port, () => {
  console.log(`Treasurio running at http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await dal.shutdown();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await dal.shutdown();
  process.exit(0);
});
