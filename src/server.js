const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const config = require('./config');
const { port, sessionSecret, n8nApiToken, requireSecret, secureCookies, groupName, groupCurrency } = config;
const dal = require('./dal');
const { verifyPassword, hashPassword } = require('./security');
const { formatDate, formatDateTime } = require('./viewHelpers');
const { validateActiveFiscalDate } = require('./fiscalYearDomain');
const { validateDuesRule, ageBandsOverlap, validateCategory } = require('./configDomain');
const { AUDIT_CHECKLIST, validateAuditItem, validateAuditFlag, validateAuditCompletion, validateAuditConclusion, validateBudgetLine, validateTransactionNote } = require('./governanceDomain');
const pgSession = require('connect-pg-simple')(session);
const {
  accountBalances,
  arrearsReport,
  calculateWelfareComponent,
  auditEvidence,
  budgetVsActual,
  currentYear,
  latestCompletedAudit,
  latestReconciliations,
  memberDue,
  runningBalanceRows,
  reportSummary,
  periodComparison,
  auditCountSummary
} = require('./services');
const {
  exportTransactionsCsv,
  exportArrearsCsv,
  exportMemberCleanupCsv,
  exportReportCsv,
  exportReconciliationsCsv,
  exportAuditLogCsv,
  exportBudgetActualCsv
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
  validatePositionEntry,
  validateRankEntry,
  validateTransferRecord,
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
const publicDirectory = path.join(__dirname, 'public');
const assetVersion = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(publicDirectory, 'app.css')))
  .update(fs.readFileSync(path.join(publicDirectory, 'app.js')))
  .digest('hex')
  .slice(0, 12);

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
app.use(express.static(publicDirectory));

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
  res.locals.assetVersion = assetVersion;
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

const FISCAL_SETUP_ROLES = new Set(['admin', 'finance_secretary', 'treasurer']);

app.use(async (req, res, next) => {
  if (!req.session.user) return next();
  try {
    const activeFiscalYear = await dal.queryOne(
      "SELECT * FROM fiscal_years WHERE status = 'open' AND is_active = true LIMIT 1"
    );
    req.activeFiscalYear = activeFiscalYear;
    res.locals.activeFiscalYear = activeFiscalYear;
    if (activeFiscalYear || req.path.startsWith('/fiscal-years') || req.path === '/logout' || req.path === '/trustee-dashboard') return next();
    if (FISCAL_SETUP_ROLES.has(req.session.user.role)) return res.redirect('/fiscal-years?setup=1');
    return res.status(503).render('setup_required');
  } catch (error) {
    return next(error);
  }
});

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

function selectedYear(req) {
  return req.activeFiscalYear ? Number(req.activeFiscalYear.year) : currentYear();
}

async function transactionYearError(req, txDate) {
  const validationError = validateActiveFiscalDate(req.activeFiscalYear, txDate);
  if (validationError) return validationError;
  return (await isYearClosed(txDate)) ? 'That year is closed. No new transactions are allowed.' : null;
}

async function duesRulesAreLocked(year) {
  const fiscalYear = await dal.queryOne('SELECT status FROM fiscal_years WHERE year = $1', [year]);
  if (!fiscalYear || fiscalYear.status === 'closed') return true;
  const usage = await dal.queryOne(`
    SELECT COUNT(*)::int AS count
    FROM transactions t
    JOIN transaction_categories c ON c.name = t.category
    WHERE c.purpose = 'assessment' AND t.status = 'posted'
      AND SUBSTRING(t.tx_date FROM 1 FOR 4) = $1
  `, [String(year)]);
  return Number(usage.count) > 0;
}

async function paymentSplitIsLocked(year, category) {
  const usage = await dal.queryOne(`
    SELECT COUNT(*)::int AS count
    FROM transactions
    WHERE category = $1 AND status = 'posted'
      AND SUBSTRING(tx_date FROM 1 FOR 4) = $2
  `, [category, String(year)]);
  return Number(usage.count) > 0;
}

async function overlappingDuesRule(year, values, excludeId = null) {
  const rules = await dal.query(
    'SELECT * FROM dues_rules WHERE year = $1 AND active = true AND ($2::int IS NULL OR id <> $2)',
    [year, excludeId]
  );
  return rules.find(rule => ageBandsOverlap(
    { min_age: values.minAge, max_age: values.maxAge }, rule
  ));
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
  // Resolve commandery for the session (single-commandery app)
  const cmdRow = await dal.queryOne('SELECT id FROM commanderies WHERE active = true ORDER BY id LIMIT 1');
  if (cmdRow) req.session.user.commandery_id = cmdRow.id;
  await dal.audit(user.id, 'login', 'user', user.id, user.email, { ip_address: getClientIp(req) });
  // Redirect trustees to their dedicated financial overview dashboard
  if (user.role === 'trustee') {
    return res.redirect('/trustee-dashboard');
  }
  res.redirect('/');
}));

app.post('/logout', requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireLogin, asyncHandler(async (req, res) => {
  try {
    const year = selectedYear(req);
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const summary = await reportSummary(yearStart, yearEnd);
    const dashboardMonth = monthPeriod(year, year === new Date().getFullYear() ? new Date().getMonth() + 1 : 1);
    const monthSummary = await reportSummary(dashboardMonth.startDate, dashboardMonth.endDate);
    const recent = await dal.query(`
      SELECT t.*, m.name AS member_name, a.name AS account_name
      FROM transactions t
      LEFT JOIN members m ON m.id = t.member_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.status = 'posted' AND t.tx_date >= $1 AND t.tx_date <= $2
      ORDER BY t.tx_date DESC, t.id DESC
      LIMIT 10
    `, [yearStart, yearEnd]);
    const memberCountRow = await dal.queryOne("SELECT COUNT(*) AS count FROM members WHERE status = 'active'");
    const memberCount = Number(memberCountRow.count);
    const unreconciledRow = await dal.queryOne("SELECT COUNT(*) AS count FROM transactions WHERE status = 'posted' AND reconciled = false AND tx_date >= $1 AND tx_date <= $2", [yearStart, yearEnd]);
    const unreconciledCount = Number(unreconciledRow.count);
    const arrearsData = await arrearsReport(selectedYear(req));
    const arrearsCount = arrearsData.filter((row) => row.balance > 0).length;
    const lastRecRow = await dal.queryOne('SELECT MAX(period_end) AS date FROM reconciliations');
    const lastReconciliation = lastRecRow ? lastRecRow.date : null;
    res.render('dashboard', { summary, monthSummary, dashboardMonth, recent, memberCount, unreconciledCount, arrearsCount, lastReconciliation });
  } catch (err) {
    console.error('Dashboard data load error:', err.message);
    res.render('dashboard', {
      error: true,
      summary: { balances: [], income: 0, expenses: 0, welfareLiability: 0, spendableBalance: 0 },
      monthSummary: { income: 0, expenses: 0 },
      dashboardMonth: { label: 'Current period' },
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
      const result = await importMembers(fileBuffer, filename, req.session.user.id, selectedYear(req));
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
  const openingArrears = req.body.opening_arrears != null && req.body.opening_arrears !== ''
    ? parseFloat(req.body.opening_arrears)
    : Number(member.opening_arrears || 0);
  const result = await dal.run(`
    UPDATE members
    SET name=$1, title=$2, first_name=$3, middle_name=$4, last_name=$5,
        preferred_name=$6, phone=$7, secondary_phone=$8, email=$9, dob=$10,
        residential_address=$11, parish=$12, occupation=$13,
        date_first_admitted=$14, notes=$15, opening_arrears=$16
    WHERE id=$17
  `, [
    values.name, values.title, values.first_name, values.middle_name, values.last_name,
    values.preferred_name, values.phone, values.secondary_phone, values.email, values.dob,
    values.residential_address, values.parish, values.occupation, values.date_first_admitted, values.notes,
    isNaN(openingArrears) ? 0 : openingArrears,
    Number(req.params.id)
  ]);
  if (result.rowCount === 0) return res.status(404).render('error', { message: 'Member not found.' });
  await dal.audit(req.session.user.id, 'update', 'member', member.id, values.name, {
    ip_address: getClientIp(req), user_agent: req.get('user-agent'), before_value: member, after_value: { ...values, opening_arrears: openingArrears }
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
  const [statusHistory, rankHistory, positionHistory, transferRecord, rankDefinitions, positionDefinitions, memberDegrees] = await Promise.all([
    dal.query(`
      SELECT h.*, u.name AS changed_by_name
      FROM member_status_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.member_id = $1 ORDER BY h.effective_date DESC, h.id DESC
    `, [member.id]),
    dal.getRankHistory(member.id),
    dal.getPositionHistory(member.id),
    dal.getTransferRecord(member.id),
    dal.getRankDefinitions(req.session.user.commandery_id),
    dal.getPositionDefinitions(req.session.user.commandery_id),
    dal.getMemberDegrees(member.id),
  ]);
  const mayViewEmergency = canViewEmergencyContacts(req.session.user.role);
  const emergencyContacts = mayViewEmergency
    ? await dal.query('SELECT * FROM member_emergency_contacts WHERE member_id = $1 ORDER BY is_primary DESC, id', [member.id])
    : [];
  res.render('member_profile', {
    member, statusHistory, rankHistory, positionHistory, transferRecord,
    rankDefinitions, positionDefinitions, memberDegrees,
    emergencyContacts, statuses: MEMBER_STATUSES,
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

app.post('/members/:id/ranks', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const errors = validateRankEntry(req.body);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/members/${memberId}`);
  }
  const data = {
    rank_title: req.body.rank_title.trim(),
    date_conferred: req.body.date_conferred,
    conferring_authority: req.body.conferring_authority ? req.body.conferring_authority.trim() : null,
  };
  await dal.createRankEntry(req.session.user.commandery_id, memberId, data, req.session.user.id);
  req.session.flash = { type: 'success', message: 'Rank entry added successfully.' };
  res.redirect(`/members/${memberId}`);
}));

app.post('/members/:id/degrees', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const degree = Number(req.body.degree);
  const dateConferred = (req.body.date_conferred || '').trim();

  if (!degree || degree < 1 || degree > 5) {
    req.session.flash = { type: 'error', message: 'Select a valid degree (1st through 5th).' };
    return res.redirect(`/members/${memberId}`);
  }
  if (!dateConferred) {
    req.session.flash = { type: 'error', message: 'Date conferred is required.' };
    return res.redirect(`/members/${memberId}`);
  }

  await dal.conferDegree(
    req.session.user.commandery_id,
    memberId,
    degree,
    dateConferred,
    req.body.conferring_authority ? req.body.conferring_authority.trim() : null,
    req.body.notes ? req.body.notes.trim() : null,
    req.session.user.id
  );
  req.session.flash = { type: 'success', message: `${degree}${degree === 1 ? 'st' : degree === 2 ? 'nd' : degree === 3 ? 'rd' : 'th'} Degree recorded successfully.` };
  res.redirect(`/members/${memberId}`);
}));

app.post('/members/:id/positions', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const errors = validatePositionEntry(req.body);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/members/${memberId}`);
  }
  const data = {
    position_title: req.body.position_title.trim(),
    position_level: req.body.position_level || 'local_commandery',
    start_date: req.body.start_date,
    end_date: req.body.end_date ? req.body.end_date.trim() : null,
  };
  await dal.createPositionEntry(req.session.user.commandery_id, memberId, data, req.session.user.id);
  req.session.flash = { type: 'success', message: 'Position entry added successfully.' };
  res.redirect(`/members/${memberId}`);
}));

app.post('/members/:id/positions/:posId/end', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const posId = Number(req.params.posId);

  // Validate end_date is present and valid format
  const endDate = (req.body.end_date || '').trim();
  if (!endDate) {
    req.session.flash = { type: 'error', message: 'End date is required.' };
    return res.redirect(`/members/${memberId}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    req.session.flash = { type: 'error', message: 'End date must be a valid date (YYYY-MM-DD).' };
    return res.redirect(`/members/${memberId}`);
  }

  // Load the position to validate end_date >= start_date
  const position = await dal.queryOne(
    'SELECT * FROM member_position_history WHERE id = $1 AND member_id = $2',
    [posId, memberId]
  );
  if (!position) {
    req.session.flash = { type: 'error', message: 'Position not found.' };
    return res.redirect(`/members/${memberId}`);
  }

  const end = new Date(endDate + 'T00:00:00');
  const start = new Date(position.start_date.toISOString().slice(0, 10) + 'T00:00:00');
  if (end < start) {
    req.session.flash = { type: 'error', message: 'End date must not be before the position start date.' };
    return res.redirect(`/members/${memberId}`);
  }

  // Update position end date via DAL
  const updated = await dal.setPositionEndDate(posId, endDate, req.session.user.id);
  if (!updated) {
    req.session.flash = { type: 'error', message: 'Failed to update position end date.' };
    return res.redirect(`/members/${memberId}`);
  }

  req.session.flash = { type: 'success', message: 'Position end date set successfully.' };
  res.redirect(`/members/${memberId}`);
}));

app.post('/members/:id/transfer', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const member = await dal.queryOne('SELECT id, date_first_admitted FROM members WHERE id = $1', [memberId]);
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });
  const errors = validateTransferRecord(req.body, member.date_first_admitted);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/members/${memberId}`);
  }
  const data = {
    origin_commandery_name: req.body.origin_commandery_name.trim(),
    transfer_date: req.body.transfer_date,
    reference_number: req.body.reference_number ? req.body.reference_number.trim() : null,
  };
  await dal.upsertTransferRecord(req.session.user.commandery_id, memberId, data, req.session.user.id);
  req.session.flash = { type: 'success', message: 'Transfer record saved successfully.' };
  res.redirect(`/members/${memberId}`);
}));

// ─── Rank History Edit/Delete ───────────────────────────────────────────────

app.post('/members/:id/ranks/:rankId/edit', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const rankId = Number(req.params.rankId);
  const existing = await dal.queryOne('SELECT * FROM member_rank_history WHERE id = $1 AND member_id = $2', [rankId, memberId]);
  if (!existing) {
    req.session.flash = { type: 'error', message: 'Rank entry not found.' };
    return res.redirect(`/members/${memberId}`);
  }
  const errors = validateRankEntry(req.body);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/members/${memberId}`);
  }
  const data = {
    date_conferred: req.body.date_conferred,
    conferring_authority: req.body.conferring_authority ? req.body.conferring_authority.trim() : null,
  };
  await dal.updateRankEntry(rankId, data, req.session.user.id);
  await dal.audit(req.session.user.id, 'update', 'member_rank_history', rankId,
    { member_id: memberId }, { ip_address: getClientIp(req), user_agent: req.get('user-agent'),
      before_value: { date_conferred: existing.date_conferred, conferring_authority: existing.conferring_authority },
      after_value: data });
  req.session.flash = { type: 'success', message: 'Rank entry updated.' };
  res.redirect(`/members/${memberId}`);
}));

app.post('/members/:id/ranks/:rankId/delete', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const rankId = Number(req.params.rankId);
  const existing = await dal.queryOne('SELECT * FROM member_rank_history WHERE id = $1 AND member_id = $2', [rankId, memberId]);
  if (!existing) {
    req.session.flash = { type: 'error', message: 'Rank entry not found.' };
    return res.redirect(`/members/${memberId}`);
  }
  await dal.deleteRankEntry(rankId);
  await dal.audit(req.session.user.id, 'delete', 'member_rank_history', rankId,
    { member_id: memberId, rank_title: existing.rank_title }, { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Rank entry deleted.' };
  res.redirect(`/members/${memberId}`);
}));

// ─── Degree Delete ──────────────────────────────────────────────────────────

app.post('/members/:id/degrees/:degree/delete', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const degree = Number(req.params.degree);
  if (!degree || degree < 1 || degree > 5) {
    req.session.flash = { type: 'error', message: 'Invalid degree.' };
    return res.redirect(`/members/${memberId}`);
  }
  const deleted = await dal.deleteDegree(memberId, degree);
  if (!deleted) {
    req.session.flash = { type: 'error', message: 'Degree record not found.' };
    return res.redirect(`/members/${memberId}`);
  }
  await dal.audit(req.session.user.id, 'delete', 'member_degree', null,
    { member_id: memberId, degree }, { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Degree record removed.' };
  res.redirect(`/members/${memberId}`);
}));

// ─── Position History Edit/Delete ───────────────────────────────────────────

app.post('/members/:id/positions/:posId/edit', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const posId = Number(req.params.posId);
  const existing = await dal.queryOne('SELECT * FROM member_position_history WHERE id = $1 AND member_id = $2', [posId, memberId]);
  if (!existing) {
    req.session.flash = { type: 'error', message: 'Position entry not found.' };
    return res.redirect(`/members/${memberId}`);
  }
  const errors = validatePositionEntry(req.body);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/members/${memberId}`);
  }
  const data = {
    position_title: req.body.position_title.trim(),
    position_level: req.body.position_level || 'local_commandery',
    start_date: req.body.start_date,
    end_date: req.body.end_date ? req.body.end_date.trim() : null,
  };
  await dal.updatePositionEntry(posId, data, req.session.user.id);
  await dal.audit(req.session.user.id, 'update', 'member_position_history', posId,
    { member_id: memberId }, { ip_address: getClientIp(req), user_agent: req.get('user-agent'),
      before_value: { position_title: existing.position_title, start_date: existing.start_date, end_date: existing.end_date },
      after_value: data });
  req.session.flash = { type: 'success', message: 'Position entry updated.' };
  res.redirect(`/members/${memberId}`);
}));

app.post('/members/:id/positions/:posId/delete', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const posId = Number(req.params.posId);
  const existing = await dal.queryOne('SELECT * FROM member_position_history WHERE id = $1 AND member_id = $2', [posId, memberId]);
  if (!existing) {
    req.session.flash = { type: 'error', message: 'Position entry not found.' };
    return res.redirect(`/members/${memberId}`);
  }
  await dal.deletePositionEntry(posId);
  await dal.audit(req.session.user.id, 'delete', 'member_position_history', posId,
    { member_id: memberId, position_title: existing.position_title }, { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Position entry deleted.' };
  res.redirect(`/members/${memberId}`);
}));

// ─── Transfer Record Delete ─────────────────────────────────────────────────

app.post('/members/:id/transfer/delete', requireLogin, asyncHandler(async (req, res) => {
  if (!canEditMembership(req.session.user.role)) {
    return res.status(403).render('error', { message: 'You do not have permission to perform this action.' });
  }
  const memberId = Number(req.params.id);
  const existing = await dal.getTransferRecord(memberId);
  if (!existing) {
    req.session.flash = { type: 'error', message: 'No transfer record found.' };
    return res.redirect(`/members/${memberId}`);
  }
  await dal.deleteTransferRecord(memberId);
  await dal.audit(req.session.user.id, 'delete', 'member_transfer', existing.id,
    { member_id: memberId, origin: existing.origin_commandery_name }, { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Transfer record deleted.' };
  res.redirect(`/members/${memberId}`);
}));

// ─── Emergency Contact Edit/Delete ──────────────────────────────────────────

app.post('/members/:id/emergency-contacts/:contactId/edit', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const memberId = Number(req.params.id);
  const contactId = Number(req.params.contactId);
  const existing = await dal.queryOne('SELECT * FROM member_emergency_contacts WHERE id = $1 AND member_id = $2', [contactId, memberId]);
  if (!existing) {
    req.session.flash = { type: 'error', message: 'Emergency contact not found.' };
    return res.redirect(`/members/${memberId}`);
  }
  const name = String(req.body.name || '').trim();
  const relationship = String(req.body.relationship || '').trim();
  let primaryPhone;
  let secondaryPhone;
  try { primaryPhone = normalizePhone(req.body.primary_phone); } catch (error) {
    req.session.flash = { type: 'error', message: error.message };
    return res.redirect(`/members/${memberId}`);
  }
  try { secondaryPhone = normalizePhone(req.body.secondary_phone); } catch (error) {
    req.session.flash = { type: 'error', message: `Secondary ${error.message.toLowerCase()}` };
    return res.redirect(`/members/${memberId}`);
  }
  if (!name || !relationship || !primaryPhone) {
    req.session.flash = { type: 'error', message: 'Contact name, relationship, and primary phone are required.' };
    return res.redirect(`/members/${memberId}`);
  }
  const data = {
    name,
    relationship,
    primary_phone: primaryPhone,
    secondary_phone: secondaryPhone,
    address: req.body.address || null,
    notes: req.body.notes || null,
    is_primary: req.body.is_primary === 'on',
  };
  await dal.updateEmergencyContact(contactId, data, req.session.user.id);
  await dal.audit(req.session.user.id, 'update', 'member_emergency_contact', contactId,
    { member_id: memberId }, { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Emergency contact updated.' };
  res.redirect(`/members/${memberId}`);
}));

app.post('/members/:id/emergency-contacts/:contactId/delete', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const memberId = Number(req.params.id);
  const contactId = Number(req.params.contactId);
  const existing = await dal.queryOne('SELECT * FROM member_emergency_contacts WHERE id = $1 AND member_id = $2', [contactId, memberId]);
  if (!existing) {
    req.session.flash = { type: 'error', message: 'Emergency contact not found.' };
    return res.redirect(`/members/${memberId}`);
  }
  await dal.deleteEmergencyContact(contactId);
  await dal.audit(req.session.user.id, 'delete', 'member_emergency_contact', contactId,
    { member_id: memberId, name: existing.name }, { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Emergency contact deleted.' };
  res.redirect(`/members/${memberId}`);
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
  res.render('config', { accounts, splits, rules, categories, year: selectedYear(req) });
}));

app.post('/config/payment-splits', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  if (Number(req.body.year) !== selectedYear(req)) {
    req.session.flash = { type: 'error', message: `Configuration changes must use active fiscal year ${selectedYear(req)}.` };
    return res.redirect('/config');
  }
  const splitCategory = await dal.queryOne(
    "SELECT * FROM transaction_categories WHERE name = $1 AND kind IN ('income','both') AND active = true",
    [req.body.category]
  );
  if (!splitCategory) {
    req.session.flash = { type: 'error', message: 'Select an active income category before configuring its welfare split.' };
    return res.redirect('/config');
  }
  const existingSplit = await dal.queryOne(
    'SELECT * FROM payment_splits WHERE year = $1 AND category = $2',
    [Number(req.body.year), req.body.category]
  );
  if (existingSplit && await paymentSplitIsLocked(existingSplit.year, existingSplit.category)) {
    req.session.flash = { type: 'error', message: 'This split already affects posted receipts and is locked to preserve historical welfare calculations.' };
    return res.redirect('/config');
  }
  const assessmentAmount = Number(req.body.assessment_amount);
  const welfareAmount = Number(req.body.welfare_amount);
  if (!Number.isFinite(assessmentAmount) || assessmentAmount <= 0 || !Number.isFinite(welfareAmount) || welfareAmount < 0 || welfareAmount > assessmentAmount) {
    req.session.flash = { type: 'error', message: 'Split amounts are invalid. Welfare must be between zero and the full assessment amount.' };
    return res.redirect('/config');
  }
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
    assessmentAmount,
    welfareAmount
  ]);
  await dal.audit(req.session.user.id, 'upsert', 'payment_split', null, `${req.body.year} ${req.body.category}`);
  req.session.flash = { type: 'success', message: 'Payment split saved successfully.' };
  res.redirect('/config');
}));

app.post('/config/payment-splits/:id/delete', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  const split = await dal.queryOne('SELECT * FROM payment_splits WHERE id = $1', [Number(req.params.id)]);
  if (!split) return res.status(404).render('error', { message: 'Payment split not found.' });
  if (Number(split.year) !== selectedYear(req)) {
    req.session.flash = { type: 'error', message: 'Historical payment splits cannot be removed.' };
    return res.redirect('/config');
  }
  if (await paymentSplitIsLocked(split.year, split.category)) {
    req.session.flash = { type: 'error', message: 'This split affects posted receipts and cannot be removed.' };
    return res.redirect('/config');
  }
  await dal.run('DELETE FROM payment_splits WHERE id = $1', [split.id]);
  await dal.audit(req.session.user.id, 'delete', 'payment_split', split.id, `${split.year} ${split.category}`);
  req.session.flash = { type: 'success', message: 'Payment split removed.' };
  res.redirect('/config');
}));

app.post('/config/accounts', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    const accounts = await dal.query('SELECT * FROM accounts ORDER BY id');
    const splits = await dal.query('SELECT * FROM payment_splits ORDER BY year DESC, category');
    const rules = await dal.query('SELECT * FROM dues_rules ORDER BY year DESC, min_age');
    const categories = await dal.query('SELECT * FROM transaction_categories ORDER BY kind, sort_order, name');
    return res.status(400).render('config', { accounts, splits, rules, categories, year: selectedYear(req), errors: ['Account name is required.'], values: req.body });
  }
  const accountType = String(req.body.type || '');
  const openingBalance = Number(req.body.opening_balance || 0);
  if (!['cash', 'bank', 'mobile_money'].includes(accountType) || !Number.isFinite(openingBalance)) {
    req.session.flash = { type: 'error', message: 'Select a valid account type and enter a valid opening balance.' };
    return res.redirect('/config');
  }
  const result = await dal.run(`
    INSERT INTO accounts (name, type, opening_balance) VALUES ($1, $2, $3)
    RETURNING id
  `, [
    req.body.name,
    accountType,
    openingBalance
  ]);
  await dal.audit(req.session.user.id, 'create', 'account', result.rows[0].id, req.body.name);
  req.session.flash = { type: 'success', message: 'Account added successfully.' };
  res.redirect('/config');
}));

app.post('/config/accounts/:id', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const openingBalance = Number(req.body.opening_balance || 0);
  if (!name || !Number.isFinite(openingBalance)) {
    req.session.flash = { type: 'error', message: 'Account name and opening balance must be valid.' };
    return res.redirect('/config');
  }
  const isWelfareFund = req.body.is_welfare_fund ? true : false;

  // If marking this account as welfare fund, clear the flag from any other account first
  if (isWelfareFund) {
    await dal.run('UPDATE accounts SET is_welfare_fund = false WHERE is_welfare_fund = true AND id != $1', [Number(req.params.id)]);
  }

  await dal.run(`
    UPDATE accounts
    SET name = $1, opening_balance = $2, active = $3, is_welfare_fund = $4
    WHERE id = $5
  `, [
    name,
    openingBalance,
    req.body.active ? true : false,
    isWelfareFund,
    Number(req.params.id)
  ]);
  await dal.audit(req.session.user.id, 'update', 'account', Number(req.params.id), name);
  req.session.flash = { type: 'success', message: 'Account updated successfully.' };
  res.redirect('/config');
}));

app.post('/config/accounts/:id/delete', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const accountId = Number(req.params.id);
  const account = await dal.queryOne('SELECT * FROM accounts WHERE id = $1', [accountId]);
  if (!account) return res.status(404).render('error', { message: 'Account not found.' });
  const dependencies = await dal.queryOne(`
    SELECT
      (SELECT COUNT(*)::int FROM transactions WHERE account_id = $1 OR to_account_id = $1) AS transactions,
      (SELECT COUNT(*)::int FROM reconciliations WHERE account_id = $1) AS reconciliations
  `, [accountId]);
  if (Number(dependencies.transactions) > 0 || Number(dependencies.reconciliations) > 0) {
    await dal.run('UPDATE accounts SET active = false WHERE id = $1', [accountId]);
    req.session.flash = { type: 'success', message: `${account.name} has history, so it was deactivated rather than deleted.` };
  } else {
    await dal.run('DELETE FROM accounts WHERE id = $1', [accountId]);
    req.session.flash = { type: 'success', message: `${account.name} was deleted.` };
  }
  await dal.audit(req.session.user.id, 'remove', 'account', accountId, req.session.flash.message);
  res.redirect('/config');
}));

app.post('/config/categories', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const validated = validateCategory(req.body);
  if (validated.errors.length) {
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect('/config');
  }
  const duplicate = await dal.queryOne('SELECT id FROM transaction_categories WHERE LOWER(name) = LOWER($1)', [validated.values.name]);
  if (duplicate) {
    req.session.flash = { type: 'error', message: 'A category with that name already exists. Edit the existing category instead.' };
    return res.redirect('/config');
  }
  if (validated.values.purpose !== 'standard') {
    const purposeOwner = await dal.queryOne('SELECT name FROM transaction_categories WHERE purpose = $1 AND active = true', [validated.values.purpose]);
    if (purposeOwner) {
      req.session.flash = { type: 'error', message: `Only one active category may have that accounting purpose. It is currently assigned to ${purposeOwner.name}.` };
      return res.redirect('/config');
    }
  }
  const result = await dal.run(`
    INSERT INTO transaction_categories (name, kind, purpose, active, sort_order)
    VALUES ($1, $2, $3, true, $4) RETURNING id
  `, [validated.values.name, validated.values.kind, validated.values.purpose, validated.values.sortOrder]);
  await dal.audit(req.session.user.id, 'create', 'transaction_category', result.rows[0].id, validated.values);
  req.session.flash = { type: 'success', message: 'Category added successfully.' };
  res.redirect('/config');
}));

app.post('/config/categories/:id', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const categoryId = Number(req.params.id);
  const category = await dal.queryOne('SELECT * FROM transaction_categories WHERE id = $1', [categoryId]);
  if (!category) return res.status(404).render('error', { message: 'Category not found.' });
  const validated = validateCategory(req.body);
  if (validated.errors.length) {
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect('/config');
  }
  const duplicate = await dal.queryOne(
    'SELECT id FROM transaction_categories WHERE LOWER(name) = LOWER($1) AND id <> $2',
    [validated.values.name, categoryId]
  );
  if (duplicate) {
    req.session.flash = { type: 'error', message: 'A category with that name already exists.' };
    return res.redirect('/config');
  }
  const dependencies = await dal.queryOne(`
    SELECT
      (SELECT COUNT(*)::int FROM transactions WHERE category = $1) AS transactions,
      (SELECT COUNT(*)::int FROM payment_splits WHERE category = $1) AS splits,
      (SELECT COUNT(*)::int FROM annual_budget_lines WHERE category = $1) AS budget_lines
  `, [category.name]);
  const safeDirectionWidening = category.purpose === 'standard'
    && validated.values.purpose === 'standard'
    && ['income', 'expense'].includes(category.kind)
    && validated.values.kind === 'both';
  if ((Number(dependencies.transactions) > 0 || Number(dependencies.splits) > 0 || Number(dependencies.budget_lines) > 0)
      && (validated.values.kind !== category.kind || validated.values.purpose !== category.purpose)) {
    if (!safeDirectionWidening) {
      req.session.flash = { type: 'error', message: 'A category with financial history may be renamed, deactivated, or widened to Income & expense, but it cannot be narrowed or assigned a different accounting purpose.' };
      return res.redirect('/config');
    }
  }
  const active = req.body.active === 'on';
  if (active && validated.values.purpose !== 'standard') {
    const purposeOwner = await dal.queryOne('SELECT name FROM transaction_categories WHERE purpose = $1 AND active = true AND id <> $2', [validated.values.purpose, categoryId]);
    if (purposeOwner) {
      req.session.flash = { type: 'error', message: `Deactivate ${purposeOwner.name} before assigning the same accounting purpose.` };
      return res.redirect('/config');
    }
  }
  await dal.transaction(async (client) => {
    if (validated.values.name !== category.name) {
      await client.query('UPDATE transactions SET category = $1 WHERE category = $2', [validated.values.name, category.name]);
      await client.query('UPDATE payment_splits SET category = $1 WHERE category = $2', [validated.values.name, category.name]);
      await client.query('UPDATE annual_budget_lines SET category = $1 WHERE category = $2', [validated.values.name, category.name]);
    }
    await client.query(`UPDATE transaction_categories SET name=$1, kind=$2, purpose=$3, active=$4, sort_order=$5 WHERE id=$6`,
      [validated.values.name, validated.values.kind, validated.values.purpose, active, validated.values.sortOrder, categoryId]);
    await dal.audit(req.session.user.id, 'update', 'transaction_category', categoryId, validated.values,
      { client, before_value: category, after_value: { ...validated.values, active } });
  });
  req.session.flash = { type: 'success', message: 'Category updated. Related transactions and payment splits remain connected.' };
  res.redirect('/config');
}));

app.post('/config/categories/:id/delete', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const categoryId = Number(req.params.id);
  const category = await dal.queryOne('SELECT * FROM transaction_categories WHERE id = $1', [categoryId]);
  if (!category) return res.status(404).render('error', { message: 'Category not found.' });
  const usage = await dal.queryOne(`
    SELECT
      (SELECT COUNT(*)::int FROM transactions WHERE category = $1) AS transactions,
      (SELECT COUNT(*)::int FROM annual_budget_lines WHERE category = $1) AS budget_lines
  `, [category.name]);
  if (Number(usage.transactions) > 0 || Number(usage.budget_lines) > 0) {
    await dal.run('UPDATE transaction_categories SET active = false WHERE id = $1', [categoryId]);
    req.session.flash = { type: 'success', message: `${category.name} has transaction or budget history, so it was deactivated rather than deleted.` };
  } else {
    await dal.transaction(async (client) => {
      await client.query('DELETE FROM payment_splits WHERE category = $1', [category.name]);
      await client.query('DELETE FROM transaction_categories WHERE id = $1', [categoryId]);
    });
    req.session.flash = { type: 'success', message: `${category.name} and its unused payment splits were deleted.` };
  }
  await dal.audit(req.session.user.id, 'remove', 'transaction_category', categoryId, req.session.flash.message);
  res.redirect('/config');
}));

// ─── Rank & Position Definitions (Admin) ──────────────────────────────────

app.get('/config/ranks', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const ranks = await dal.getRankDefinitions(req.session.user.commandery_id, false);
  res.render('config_ranks', { ranks });
}));

app.post('/config/ranks', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title || title.length > 100) {
    req.session.flash = { type: 'error', message: 'Rank title is required (max 100 characters).' };
    return res.redirect('/config/ranks');
  }
  await dal.createRankDefinition(req.session.user.commandery_id, title, Number(req.body.sort_order) || 0, req.session.user.id);
  req.session.flash = { type: 'success', message: `Rank "${title}" added.` };
  res.redirect('/config/ranks');
}));

app.post('/config/ranks/:id', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title || title.length > 100) {
    req.session.flash = { type: 'error', message: 'Rank title is required (max 100 characters).' };
    return res.redirect('/config/ranks');
  }
  await dal.updateRankDefinition(Number(req.params.id), {
    title,
    sort_order: Number(req.body.sort_order) || 0,
    active: req.body.active === 'on'
  });
  req.session.flash = { type: 'success', message: `Rank "${title}" updated.` };
  res.redirect('/config/ranks');
}));

app.get('/config/positions', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const positions = await dal.getPositionDefinitions(req.session.user.commandery_id, false);
  res.render('config_positions', { positions });
}));

app.post('/config/positions', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const title = (req.body.title || '').trim();
  const level = req.body.level || 'local_commandery';
  const validLevels = ['local_commandery', 'district_regiment', 'grand_commandery', 'supreme_subordinate', 'supreme_commandery'];
  if (!title || title.length > 100) {
    req.session.flash = { type: 'error', message: 'Position title is required (max 100 characters).' };
    return res.redirect('/config/positions');
  }
  if (!validLevels.includes(level)) {
    req.session.flash = { type: 'error', message: 'Select a valid position level.' };
    return res.redirect('/config/positions');
  }
  await dal.createPositionDefinition(req.session.user.commandery_id, title, level, Number(req.body.sort_order) || 0, req.session.user.id);
  req.session.flash = { type: 'success', message: `Position "${title}" added.` };
  res.redirect('/config/positions');
}));

app.post('/config/positions/:id', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const title = (req.body.title || '').trim();
  const level = req.body.level || 'local_commandery';
  const validLevels = ['local_commandery', 'district_regiment', 'grand_commandery', 'supreme_subordinate', 'supreme_commandery'];
  if (!title || title.length > 100) {
    req.session.flash = { type: 'error', message: 'Position title is required (max 100 characters).' };
    return res.redirect('/config/positions');
  }
  if (!validLevels.includes(level)) {
    req.session.flash = { type: 'error', message: 'Select a valid position level.' };
    return res.redirect('/config/positions');
  }
  await dal.updatePositionDefinition(Number(req.params.id), {
    title,
    level,
    sort_order: Number(req.body.sort_order) || 0,
    active: req.body.active === 'on'
  });
  req.session.flash = { type: 'success', message: `Position "${title}" updated.` };
  res.redirect('/config/positions');
}));

app.get('/budgets', requireLogin, asyncHandler(async (req, res) => {
  const years = await dal.query('SELECT year, status FROM fiscal_years ORDER BY year DESC');
  const requestedYear = Number(req.query.year || selectedYear(req));
  const year = years.some((item) => Number(item.year) === requestedYear) ? requestedYear : selectedYear(req);
  const [report, categories] = await Promise.all([
    budgetVsActual(year),
    dal.query("SELECT name, kind FROM transaction_categories WHERE active = true ORDER BY sort_order, name")
  ]);
  const role = req.session.user.role;
  const canManage = ['admin', 'treasurer'].includes(role);
  const fiscalYear = years.find((item) => Number(item.year) === Number(year));
  const canEdit = canManage && fiscalYear && fiscalYear.status === 'open' && (!report.header || report.header.status === 'draft');
  res.render('budgets', { year, years, report, categories, canEdit, canApprove: role === 'admin' });
}));

app.post('/budgets/lines', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const validated = validateBudgetLine(req.body);
  if (validated.errors.length) {
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect(`/budgets?year=${encodeURIComponent(req.body.year || selectedYear(req))}`);
  }
  const { year, category, kind, amount, notes } = validated.values;
  const [fiscalYear, header, categoryConfig, existingLine] = await Promise.all([
    dal.queryOne('SELECT * FROM fiscal_years WHERE year = $1', [year]),
    dal.queryOne('SELECT * FROM annual_budgets WHERE year = $1', [year]),
    dal.queryOne('SELECT * FROM transaction_categories WHERE name = $1 AND active = true', [category]),
    dal.queryOne('SELECT * FROM annual_budget_lines WHERE year=$1 AND category=$2 AND kind=$3', [year, category, kind])
  ]);
  if (!fiscalYear || fiscalYear.status !== 'open') {
    req.session.flash = { type: 'error', message: 'Budgets can only be changed for an open fiscal year.' };
    return res.redirect(`/budgets?year=${year}`);
  }
  if (header && header.status === 'approved') {
    req.session.flash = { type: 'error', message: 'This budget is approved and locked. An administrator must reopen it before changes can be made.' };
    return res.redirect(`/budgets?year=${year}`);
  }
  if (!categoryConfig || ![kind, 'both'].includes(categoryConfig.kind)) {
    req.session.flash = { type: 'error', message: `The selected category is not available for ${kind} budgeting.` };
    return res.redirect(`/budgets?year=${year}`);
  }
  await dal.transaction(async (client) => {
    await client.query(`
      INSERT INTO annual_budgets (year, status, notes, created_by, updated_by)
      VALUES ($1, 'draft', $2, $3, $3)
      ON CONFLICT(year) DO UPDATE SET notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `, [year, String(req.body.budget_notes || '').trim() || null, req.session.user.id]);
    const result = await client.query(`
      INSERT INTO annual_budget_lines (year, category, kind, amount, notes)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(year, category, kind) DO UPDATE SET amount=EXCLUDED.amount, notes=EXCLUDED.notes, updated_at=NOW()
      RETURNING id
    `, [year, category, kind, amount, notes || null]);
    await dal.audit(req.session.user.id, 'upsert', 'annual_budget_line', result.rows[0].id,
      { year, category, kind, amount, notes }, {
        client, before_value: existingLine, after_value: { year, category, kind, amount, notes },
        ip_address: getClientIp(req), user_agent: req.get('user-agent')
      });
  });
  req.session.flash = { type: 'success', message: 'Budget line saved.' };
  res.redirect(`/budgets?year=${year}`);
}));

app.post('/budgets/lines/:id/delete', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const line = await dal.queryOne(`SELECT l.*, b.status FROM annual_budget_lines l JOIN annual_budgets b ON b.year=l.year WHERE l.id=$1`, [Number(req.params.id)]);
  if (!line) return res.status(404).render('error', { message: 'Budget line not found.' });
  const fiscalYear = await dal.queryOne('SELECT status FROM fiscal_years WHERE year=$1', [line.year]);
  if (!fiscalYear || fiscalYear.status !== 'open' || line.status !== 'draft') {
    req.session.flash = { type: 'error', message: 'Only draft budgets in an open fiscal year can be changed.' };
    return res.redirect(`/budgets?year=${line.year}`);
  }
  await dal.run('DELETE FROM annual_budget_lines WHERE id=$1', [line.id]);
  await dal.audit(req.session.user.id, 'delete', 'annual_budget_line', line.id, line,
    { before_value: line, ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: 'Budget line removed.' };
  res.redirect(`/budgets?year=${line.year}`);
}));

app.post('/budgets/:year/approve', allow('admin'), asyncHandler(async (req, res) => {
  const year = Number(req.params.year);
  const [lineCount, fiscalYear] = await Promise.all([
    dal.queryOne('SELECT COUNT(*)::int AS count FROM annual_budget_lines WHERE year=$1', [year]),
    dal.queryOne('SELECT status FROM fiscal_years WHERE year=$1', [year])
  ]);
  if (!fiscalYear || fiscalYear.status !== 'open') {
    req.session.flash = { type: 'error', message: 'Only a budget for an open fiscal year can be approved.' };
    return res.redirect(`/budgets?year=${year}`);
  }
  if (!lineCount || Number(lineCount.count) === 0) {
    req.session.flash = { type: 'error', message: 'Add at least one budget line before approval.' };
    return res.redirect(`/budgets?year=${year}`);
  }
  const result = await dal.run(`UPDATE annual_budgets SET status='approved', approved_by=$1, approved_at=NOW(), updated_by=$1, updated_at=NOW() WHERE year=$2 AND status='draft' RETURNING year`, [req.session.user.id, year]);
  if (!result.rowCount) return res.status(409).render('error', { message: 'The budget is already approved or does not exist.' });
  await dal.audit(req.session.user.id, 'approve', 'annual_budget', year, `Approved annual budget ${year}`,
    { ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: `Budget ${year} approved and locked.` };
  res.redirect(`/budgets?year=${year}`);
}));

app.post('/budgets/:year/reopen', allow('admin'), asyncHandler(async (req, res) => {
  const year = Number(req.params.year);
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    req.session.flash = { type: 'error', message: 'A reason is required to reopen an approved budget.' };
    return res.redirect(`/budgets?year=${year}`);
  }
  const fiscalYear = await dal.queryOne('SELECT status FROM fiscal_years WHERE year=$1', [year]);
  if (!fiscalYear || fiscalYear.status !== 'open') {
    req.session.flash = { type: 'error', message: 'A budget can only be reopened while its fiscal year is open.' };
    return res.redirect(`/budgets?year=${year}`);
  }
  const result = await dal.run(`UPDATE annual_budgets SET status='draft', approved_by=NULL, approved_at=NULL, updated_by=$1, updated_at=NOW() WHERE year=$2 AND status='approved' RETURNING year`, [req.session.user.id, year]);
  if (!result.rowCount) return res.status(409).render('error', { message: 'The budget is not currently approved.' });
  await dal.audit(req.session.user.id, 'reopen', 'annual_budget', year, reason,
    { reason, ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  req.session.flash = { type: 'success', message: `Budget ${year} reopened for amendment.` };
  res.redirect(`/budgets?year=${year}`);
}));

app.get('/fiscal-years', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
  const currentYearValue = currentYear();
  const currentYearExists = years.some(y => y.year === currentYearValue);
  res.render('fiscal_years', { years, currentYear: currentYearValue, currentYearExists, setup: req.query.setup === '1' });
}));

app.post('/fiscal-years/open', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  if (!year || year < 2000 || year > 2100) {
    const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
    return res.status(400).render('fiscal_years', { years, currentYear: currentYear(), errors: ['Invalid year. Must be between 2000 and 2100.'], values: req.body });
  }

  const currentlyActive = await dal.queryOne("SELECT year FROM fiscal_years WHERE status = 'open' AND is_active = true LIMIT 1");
  if (currentlyActive) {
    const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
    return res.status(400).render('fiscal_years', {
      years, currentYear: currentYear(), values: req.body,
      errors: [`Fiscal year ${currentlyActive.year} is active. Close it before opening a new year.`]
    });
  }

  const existing = await dal.queryOne('SELECT * FROM fiscal_years WHERE year = $1', [year]);
  if (existing) {
    const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
    return res.status(400).render('fiscal_years', { years, currentYear: currentYear(), errors: [`Year ${year} is already ${existing.status}.`], values: req.body });
  }

  await dal.transaction(async (client) => {
    await client.query('UPDATE fiscal_years SET is_active = false WHERE is_active = true');
    await client.query("INSERT INTO fiscal_years (year, status, is_active) VALUES ($1, 'open', true)", [year]);
  });

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

app.post('/fiscal-years/:year/activate', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const year = Number(req.params.year);
  const fiscalYear = await dal.queryOne('SELECT * FROM fiscal_years WHERE year = $1', [year]);
  if (!fiscalYear || fiscalYear.status !== 'open') {
    req.session.flash = { type: 'error', message: 'Only an open fiscal year can be made active.' };
    return res.redirect('/fiscal-years');
  }
  await dal.transaction(async (client) => {
    await client.query('UPDATE fiscal_years SET is_active = false WHERE is_active = true');
    await client.query('UPDATE fiscal_years SET is_active = true WHERE year = $1', [year]);
    await dal.audit(req.session.user.id, 'activate', 'fiscal_year', year,
      `Selected ${year} as the active fiscal year`, { client });
  });
  req.session.flash = { type: 'success', message: `Fiscal year ${year} is now active.` };
  res.redirect('/fiscal-years');
}));

app.post('/fiscal-years/close', allow('admin'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const fy = await dal.queryOne('SELECT * FROM fiscal_years WHERE year = $1', [year]);
  if (!fy || fy.status !== 'open' || !fy.is_active) {
    const years = await dal.query('SELECT * FROM fiscal_years ORDER BY year DESC');
    return res.status(400).render('fiscal_years', { years, currentYear: currentYear(), errors: [`Year ${year} is not the active open fiscal year.`], values: req.body });
  }

  // Calculate closing arrears for each active member and carry forward
  const arrears = await arrearsReport(year);

  await dal.transaction(async (client) => {
    for (const row of arrears) {
      // Carry both arrears (positive) and member credits (negative) forward.
      const carryForward = row.balance;
      await client.query('UPDATE members SET opening_arrears = $1 WHERE id = $2', [carryForward, row.member_id]);
    }

    await client.query(
      "UPDATE fiscal_years SET status = 'closed', is_active = false, closed_at = NOW(), closed_by = $1, notes = $2 WHERE year = $3",
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
  let overrides = [];
  try {
    overrides = await dal.query(`
      SELECT md.*, m.name
      FROM member_dues md
      LEFT JOIN members m ON m.id = md.member_id
      ORDER BY md.year DESC, m.name
    `);
  } catch (e) {
    if (e.code === '42P01') {
      // Table doesn't exist yet — create it
      await dal.run(`
        CREATE TABLE IF NOT EXISTS member_dues (
          id SERIAL PRIMARY KEY,
          member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          year INTEGER NOT NULL,
          assessment_due NUMERIC(12,2) NOT NULL DEFAULT 0,
          welfare_portion NUMERIC(12,2) NOT NULL DEFAULT 0,
          reason TEXT,
          UNIQUE(member_id, year)
        )
      `);
    } else {
      console.error('[dues] Error loading overrides:', e.message);
    }
  }
  console.log('[dues] Overrides found:', overrides.length);

  // Raw count for diagnostic (bypasses JOIN)
  let overrideCountRaw = 'table missing';
  try {
    const rawCountRow = await dal.queryOne('SELECT COUNT(*)::int AS count FROM member_dues');
    overrideCountRaw = rawCountRow ? rawCountRow.count : 0;
  } catch (e) {
    if (e.code === '42P01') {
      overrideCountRaw = 'TABLE DOES NOT EXIST — run: npm run migrate';
    } else {
      overrideCountRaw = 'Query error: ' + e.message;
    }
  }

  // Compute effective dues for all active members for the selected year
  const year = selectedYear(req);
  const activeMembers = await dal.query("SELECT id, name, dob FROM members WHERE status = 'active' ORDER BY name");
  const overrideSet = new Set(
    overrides.filter(o => Number(o.year) === year).map(o => o.member_id)
  );
  const effectiveDues = [];
  for (const member of activeMembers) {
    const due = await memberDue(member, year);
    effectiveDues.push({
      id: member.id,
      name: member.name,
      assessment_due: due.assessment_due,
      welfare_portion: due.welfare_portion,
      source: overrideSet.has(member.id) ? 'Override' : 'Rule'
    });
  }

  res.render('dues', {
    rules, members, overrides, year,
    effectiveDues, overrideCountRaw,
    canManage: ['admin', 'finance_secretary'].includes(req.session.user.role)
  });
}));

app.post('/dues/rules', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  if (Number(req.body.year) !== selectedYear(req)) {
    req.session.flash = { type: 'error', message: `Dues rules must use active fiscal year ${selectedYear(req)}.` };
    return res.redirect('/dues');
  }
  if (await duesRulesAreLocked(selectedYear(req))) {
    req.session.flash = { type: 'error', message: 'Dues rules are locked after assessment payments are posted. Use a member-specific override for exceptions.' };
    return res.redirect('/dues');
  }
  const validated = validateDuesRule(req.body);
  if (validated.errors.length) {
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect('/dues');
  }
  const overlap = await overlappingDuesRule(selectedYear(req), validated.values);
  if (overlap) {
    req.session.flash = { type: 'error', message: `This age band overlaps the active rule “${overlap.label}”. Adjust or edit that rule first.` };
    return res.redirect('/dues');
  }
  const result = await dal.run(`
    INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [
    Number(req.body.year),
    validated.values.label,
    validated.values.minAge,
    validated.values.maxAge,
    validated.values.assessment,
    validated.values.welfare
  ]);
  await dal.audit(req.session.user.id, 'create', 'dues_rule', result.rows[0].id, req.body.label);
  req.session.flash = { type: 'success', message: 'Dues rule added successfully.' };
  res.redirect('/dues');
}));

app.post('/dues/rules/:id', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.id);
  const rule = await dal.queryOne('SELECT * FROM dues_rules WHERE id = $1', [ruleId]);
  if (!rule) return res.status(404).render('error', { message: 'Dues rule not found.' });
  if (Number(rule.year) !== selectedYear(req) || await duesRulesAreLocked(rule.year)) {
    req.session.flash = { type: 'error', message: 'This rule is historical or already affects posted assessment payments, so it is locked.' };
    return res.redirect('/dues');
  }
  const validated = validateDuesRule(req.body);
  if (validated.errors.length) {
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect('/dues');
  }
  const overlap = await overlappingDuesRule(rule.year, validated.values, ruleId);
  if (overlap) {
    req.session.flash = { type: 'error', message: `This age band overlaps the active rule “${overlap.label}”.` };
    return res.redirect('/dues');
  }
  const active = req.body.active === 'on';
  await dal.run(`UPDATE dues_rules SET label=$1,min_age=$2,max_age=$3,annual_assessment=$4,welfare_portion=$5,active=$6 WHERE id=$7`,
    [validated.values.label, validated.values.minAge, validated.values.maxAge,
      validated.values.assessment, validated.values.welfare, active, ruleId]);
  await dal.audit(req.session.user.id, 'update', 'dues_rule', ruleId, validated.values,
    { before_value: rule, after_value: { ...validated.values, active } });
  req.session.flash = { type: 'success', message: 'Dues rule updated.' };
  res.redirect('/dues');
}));

app.post('/dues/rules/:id/delete', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  const ruleId = Number(req.params.id);
  const rule = await dal.queryOne('SELECT * FROM dues_rules WHERE id = $1', [ruleId]);
  if (!rule) return res.status(404).render('error', { message: 'Dues rule not found.' });
  if (Number(rule.year) !== selectedYear(req) || await duesRulesAreLocked(rule.year)) {
    req.session.flash = { type: 'error', message: 'This rule is historical or already affects posted assessment payments and cannot be deleted.' };
    return res.redirect('/dues');
  }
  await dal.run('DELETE FROM dues_rules WHERE id = $1', [ruleId]);
  await dal.audit(req.session.user.id, 'delete', 'dues_rule', ruleId, rule);
  req.session.flash = { type: 'success', message: 'Dues rule deleted.' };
  res.redirect('/dues');
}));

app.post('/dues/overrides', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  if (Number(req.body.year) !== selectedYear(req)) {
    req.session.flash = { type: 'error', message: `Dues overrides must use active fiscal year ${selectedYear(req)}.` };
    return res.redirect('/dues');
  }
  const assessmentDue = Number(req.body.assessment_due);
  const welfarePortion = Number(req.body.welfare_portion);
  if (!Number.isFinite(assessmentDue) || assessmentDue < 0 || !Number.isFinite(welfarePortion)
      || welfarePortion < 0 || welfarePortion > assessmentDue) {
    req.session.flash = { type: 'error', message: 'Override amounts are invalid. Welfare must be between zero and the assessment due.' };
    return res.redirect('/dues');
  }
  const member = await dal.queryOne('SELECT id FROM members WHERE id = $1', [Number(req.body.member_id)]);
  if (!member) {
    req.session.flash = { type: 'error', message: 'Select a valid member.' };
    return res.redirect('/dues');
  }
  const insertResult = await dal.run(`
    INSERT INTO member_dues (member_id, year, assessment_due, welfare_portion, reason)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(member_id, year) DO UPDATE SET
      assessment_due = EXCLUDED.assessment_due,
      welfare_portion = EXCLUDED.welfare_portion,
      reason = EXCLUDED.reason
    RETURNING *
  `, [
    Number(req.body.member_id),
    Number(req.body.year),
    assessmentDue,
    welfarePortion,
    req.body.reason || null
  ]).catch(async (err) => {
    // If the table doesn't exist, create it and retry
    if (err.code === '42P01') { // undefined_table
      console.error('[dues] member_dues table missing — creating it now');
      await dal.run(`
        CREATE TABLE IF NOT EXISTS member_dues (
          id SERIAL PRIMARY KEY,
          member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          year INTEGER NOT NULL,
          assessment_due NUMERIC(12,2) NOT NULL DEFAULT 0,
          welfare_portion NUMERIC(12,2) NOT NULL DEFAULT 0,
          reason TEXT,
          UNIQUE(member_id, year)
        )
      `);
      // Retry the insert
      return dal.run(`
        INSERT INTO member_dues (member_id, year, assessment_due, welfare_portion, reason)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(member_id, year) DO UPDATE SET
          assessment_due = EXCLUDED.assessment_due,
          welfare_portion = EXCLUDED.welfare_portion,
          reason = EXCLUDED.reason
        RETURNING *
      `, [Number(req.body.member_id), Number(req.body.year), assessmentDue, welfarePortion, req.body.reason || null]);
    }
    throw err;
  });
  console.log('[dues] Override saved:', JSON.stringify(insertResult.rows[0]));
  await dal.audit(req.session.user.id, 'upsert', 'member_due', Number(req.body.member_id), String(req.body.year));
  req.session.flash = { type: 'success', message: 'Member dues override saved.' };
  res.redirect('/dues');
}));

app.post('/dues/overrides/:id/delete', allow('admin', 'finance_secretary'), asyncHandler(async (req, res) => {
  const override = await dal.queryOne('SELECT * FROM member_dues WHERE id = $1', [Number(req.params.id)]);
  if (!override) return res.status(404).render('error', { message: 'Member dues override not found.' });
  if (Number(override.year) !== selectedYear(req)) {
    req.session.flash = { type: 'error', message: 'Historical member dues overrides cannot be removed.' };
    return res.redirect('/dues');
  }
  await dal.run('DELETE FROM member_dues WHERE id = $1', [override.id]);
  await dal.audit(req.session.user.id, 'delete', 'member_due', override.id, override);
  req.session.flash = { type: 'success', message: 'Member dues override removed; the annual age-band rule now applies.' };
  res.redirect('/dues');
}));

async function financeFormData(kind) {
  const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
  const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
  const categories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind IN ($1, 'both') ORDER BY sort_order, name", [kind]);
  return { members, accounts, categories, kind };
}

async function financeTransactions(kind, limit = 100, year = null, month = '', category = '') {
  const types = kind === 'income' ? ['receipt'] : ['expense', 'welfare_payout'];
  let query = `
    SELECT t.*, m.name AS member_name, a.name AS account_name, u.name AS recorded_by
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.tx_type = ANY($1::varchar[])
  `;
  const params = [types];
  let paramIdx = 2;

  if (year) {
    query += ` AND t.tx_date >= $${paramIdx} AND t.tx_date <= $${paramIdx + 1}`;
    params.push(`${year}-01-01`, `${year}-12-31`);
    paramIdx += 2;
  }

  if (month && month >= 1 && month <= 12) {
    const m = String(month).padStart(2, '0');
    const startDate = `${year}-${m}-01`;
    const lastDay = new Date(year, Number(month), 0).getDate();
    const endDate = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;
    query += ` AND t.tx_date >= $${paramIdx} AND t.tx_date <= $${paramIdx + 1}`;
    params.push(startDate, endDate);
    paramIdx += 2;
  }

  if (category) {
    query += ` AND t.category = $${paramIdx}`;
    params.push(category);
    paramIdx += 1;
  }

  query += ` ORDER BY t.tx_date DESC, t.id DESC LIMIT $${paramIdx}`;
  params.push(limit);

  return dal.query(query, params);
}

app.get('/finance', requireLogin, asyncHandler(async (req, res) => {
  const year = selectedYear(req);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const [summary, recent, unreconciledRow, arrearsData, lastRecRow] = await Promise.all([
    reportSummary(yearStart, yearEnd),
    dal.query(`SELECT t.*, a.name AS account_name FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.status = 'posted' AND t.tx_date >= $1 AND t.tx_date <= $2 ORDER BY t.tx_date DESC, t.id DESC LIMIT 8`, [yearStart, yearEnd]),
    dal.queryOne("SELECT COUNT(*) AS count FROM transactions WHERE status = 'posted' AND reconciled = false AND tx_date >= $1 AND tx_date <= $2", [yearStart, yearEnd]),
    arrearsReport(year),
    dal.queryOne('SELECT MAX(period_end) AS date FROM reconciliations')
  ]);
  res.render('finance_overview', {
    summary,
    recent,
    unreconciledCount: Number(unreconciledRow.count),
    arrearsCount: arrearsData.filter((row) => row.balance > 0).length,
    lastReconciliation: lastRecRow ? lastRecRow.date : null
  });
}));

app.get('/finance/income/new', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  res.render('finance_form', await financeFormData('income'));
}));

app.get('/finance/expenses/new', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  res.render('finance_form', await financeFormData('expense'));
}));

app.get('/finance/income', requireLogin, asyncHandler(async (req, res) => {
  const year = selectedYear(req);
  const month = req.query.month || '';
  const category = req.query.category || '';
  const transactions = await financeTransactions('income', 500, year, month, category);
  const categories = await dal.query("SELECT DISTINCT category FROM transactions WHERE tx_type = 'receipt' AND tx_date >= $1 AND tx_date <= $2 ORDER BY category", [`${year}-01-01`, `${year}-12-31`]);
  res.render('finance_list', { kind: 'income', transactions, selectedMonth: month, selectedCategory: category, categories: categories.map(r => r.category), fiscalYear: year });
}));

app.get('/finance/expenses', requireLogin, asyncHandler(async (req, res) => {
  const year = selectedYear(req);
  const month = req.query.month || '';
  const category = req.query.category || '';
  const transactions = await financeTransactions('expense', 500, year, month, category);
  const categories = await dal.query("SELECT DISTINCT category FROM transactions WHERE tx_type IN ('expense','welfare_payout') AND tx_date >= $1 AND tx_date <= $2 ORDER BY category", [`${year}-01-01`, `${year}-12-31`]);
  res.render('finance_list', { kind: 'expense', transactions, selectedMonth: month, selectedCategory: category, categories: categories.map(r => r.category), fiscalYear: year });
}));

app.get('/finance/accounts', requireLogin, asyncHandler(async (req, res) => {
  res.render('finance_accounts', { balances: await accountBalances() });
}));

app.get('/finance/reconciliation', allow('admin', 'treasurer', 'auditor', 'viewer'), (req, res) => res.redirect('/reconciliation'));
app.get('/finance/reports', requireLogin, (req, res) => res.redirect('/reports'));

app.get('/transactions', requireLogin, (req, res) => {
  res.redirect('/finance');
});

app.post('/transactions/receipt', allow('admin', 'finance_secretary', 'treasurer'), asyncHandler(async (req, res) => {
  const receiptYearError = await transactionYearError(req, req.body.tx_date);
  if (receiptYearError) {
    return res.status(400).render('finance_form', { ...(await financeFormData('income')), errors: [receiptYearError], values: req.body });
  }
  const receiptCategory = await dal.queryOne(
    "SELECT * FROM transaction_categories WHERE name = $1 AND kind IN ('income','both') AND active = true",
    [req.body.category]
  );
  if (!receiptCategory) return res.status(400).render('finance_form', { ...(await financeFormData('income')), errors: ['Select an active income category.'], values: req.body });
  const receiptAccount = await dal.queryOne('SELECT id FROM accounts WHERE id = $1 AND active = true', [Number(req.body.account_id)]);
  if (!receiptAccount) return res.status(400).render('finance_form', { ...(await financeFormData('income')), errors: ['Select an active account to receive the income.'], values: req.body });
  const amount = Number(req.body.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).render('finance_form', { ...(await financeFormData('income')), errors: ['Amount must be greater than zero.'], values: req.body });
  const welfare = await calculateWelfareComponent({
    memberId: req.body.member_id || null,
    category: receiptCategory.name,
    amount,
    txDate: req.body.tx_date,
    enteredWelfare: req.body.welfare_component
  });
  if (welfare < 0 || welfare > amount) {
    return res.status(400).render('finance_form', { ...(await financeFormData('income')), errors: ['Welfare component must be between zero and the total amount received.'], values: req.body });
  }

  // Check if a designated welfare account exists for auto-splitting
  const welfareAccount = await dal.queryOne('SELECT id, name FROM accounts WHERE is_welfare_fund = true AND active = true LIMIT 1');
  const shouldSplit = welfare > 0 && welfareAccount && welfareAccount.id !== Number(req.body.account_id);

  if (shouldSplit) {
    // Split into two transactions: operating portion → selected account, welfare portion → welfare account
    const operatingAmount = amount - welfare;
    const welfareCategory = await dal.queryOne("SELECT name FROM transaction_categories WHERE purpose = 'welfare_income' AND active = true LIMIT 1");
    const welfareCatName = welfareCategory ? welfareCategory.name : receiptCategory.name;

    await dal.transaction(async (client) => {
      // Transaction 1: Operating portion into selected account
      const opResult = await client.query(`
        INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, description, amount, welfare_component, reference, created_by)
        VALUES ($1, 'receipt', $2, $3, $4, $5, $6, 0, $7, $8)
        RETURNING id
      `, [req.body.tx_date, req.body.member_id || null, Number(req.body.account_id), receiptCategory.name, req.body.description || null, operatingAmount, req.body.reference || null, req.session.user.id]);

      // Transaction 2: Welfare portion into welfare account
      const wfResult = await client.query(`
        INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, description, amount, welfare_component, reference, created_by)
        VALUES ($1, 'receipt', $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [req.body.tx_date, req.body.member_id || null, welfareAccount.id, welfareCatName, (req.body.description ? req.body.description + ' (welfare)' : 'Welfare portion'), welfare, welfare, req.body.reference || null, req.session.user.id]);

      await dal.audit(req.session.user.id, 'create', 'receipt', opResult.rows[0].id, `${req.body.category} ${operatingAmount} (operating split)`);
      await dal.audit(req.session.user.id, 'create', 'receipt', wfResult.rows[0].id, `${welfareCatName} ${welfare} (welfare split)`);
    });

    req.session.flash = { type: 'success', message: `Receipt split: ${operatingAmount.toFixed(2)} operating + ${welfare.toFixed(2)} welfare (→ ${welfareAccount.name}).` };
  } else {
    // Standard single transaction (no split)
    const result = await dal.run(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, description, amount, welfare_component, reference, created_by)
      VALUES ($1, 'receipt', $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [req.body.tx_date, req.body.member_id || null, Number(req.body.account_id), receiptCategory.name, req.body.description || null, amount, welfare, req.body.reference || null, req.session.user.id]);
    await dal.audit(req.session.user.id, 'create', 'receipt', result.rows[0].id, `${req.body.category} ${amount}`);
    req.session.flash = { type: 'success', message: 'Receipt saved successfully.' };
  }

  res.redirect('/finance/income');
}));

app.post('/transactions/expense', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const expenseYearError = await transactionYearError(req, req.body.tx_date);
  if (expenseYearError) {
    return res.status(400).render('finance_form', { ...(await financeFormData('expense')), errors: [expenseYearError], values: req.body });
  }
  const expenseCategory = await dal.queryOne(
    "SELECT * FROM transaction_categories WHERE name = $1 AND kind IN ('expense','both') AND active = true",
    [req.body.category]
  );
  if (!expenseCategory) return res.status(400).render('finance_form', { ...(await financeFormData('expense')), errors: ['Select an active expense category.'], values: req.body });
  const expenseAccount = await dal.queryOne('SELECT id FROM accounts WHERE id = $1 AND active = true', [Number(req.body.account_id)]);
  if (!expenseAccount) return res.status(400).render('finance_form', { ...(await financeFormData('expense')), errors: ['Select an active account to pay from.'], values: req.body });
  const expenseAmount = Number(req.body.amount || 0);
  if (!Number.isFinite(expenseAmount) || expenseAmount <= 0) return res.status(400).render('finance_form', { ...(await financeFormData('expense')), errors: ['Amount must be greater than zero.'], values: req.body });
  const type = expenseCategory.purpose === 'welfare_payout' ? 'welfare_payout' : 'expense';
  const result = await dal.run(`
    INSERT INTO transactions (tx_date, tx_type, account_id, category, description, amount, reference, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [req.body.tx_date, type, Number(req.body.account_id), expenseCategory.name, req.body.description || null, expenseAmount, req.body.reference || null, req.session.user.id]);
  await dal.audit(req.session.user.id, 'create', type, result.rows[0].id, `${req.body.category} ${req.body.amount}`);
  req.session.flash = { type: 'success', message: 'Expense saved successfully.' };
  res.redirect('/finance/expenses');
}));

app.post('/transactions/transfer', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const transferYearError = await transactionYearError(req, req.body.tx_date);
  if (transferYearError) {
    const members = await dal.query("SELECT id, name FROM members WHERE status = $1 ORDER BY name", ['active']);
    const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
    const incomeCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind IN ('income','both') ORDER BY sort_order, name");
    const expenseCategories = await dal.query("SELECT name FROM transaction_categories WHERE active = true AND kind IN ('expense','both') ORDER BY sort_order, name");
    const transactions = await dal.query(`SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id ORDER BY t.tx_date DESC, t.id DESC LIMIT 100`);
    return res.status(400).render('transactions', { transactions, members, accounts, incomeCategories, expenseCategories, errors: [transferYearError], values: req.body });
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
  const reversalYearError = await transactionYearError(req, original.tx_date);
  if (reversalYearError) return res.status(400).render('error', { message: reversalYearError });

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
  res.redirect(original.tx_type === 'receipt' ? '/finance/income' : '/finance/expenses');
}));

app.post('/transactions/:id/reconcile', allow('admin', 'finance_secretary', 'treasurer', 'auditor'), asyncHandler(async (req, res) => {
  const txId = Number(req.params.id);
  const tx = await dal.queryOne('SELECT * FROM transactions WHERE id = $1', [txId]);
  if (!tx) return res.status(404).render('error', { message: 'Transaction not found.' });

  const isReconciled = tx.reconciled ? false : true;
  await dal.run('UPDATE transactions SET reconciled = $1, updated_at = NOW() WHERE id = $2', [isReconciled, txId]);
  await dal.audit(req.session.user.id, 'update', 'transaction', txId, `Reconciled: ${isReconciled ? 'Yes' : 'No'}`);
  res.redirect(tx.tx_type === 'receipt' ? '/finance/income' : '/finance/expenses');
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
  const startYear = Number(String(req.body.period_start || '').slice(0, 4));
  const endYear = Number(String(req.body.period_end || '').slice(0, 4));
  if (startYear !== selectedYear(req) || endYear !== selectedYear(req)) {
    req.session.flash = { type: 'error', message: `Reconciliations must be within active fiscal year ${selectedYear(req)}.` };
    return res.redirect('/reconciliation');
  }
  const accountId = Number(req.body.account_id);
  const balances = await accountBalances();
  const account = balances.find((item) => item.id === accountId);
  const systemBalance = account ? account.balance : 0;
  const statementBalance = Number(req.body.statement_balance || 0);
  const result = await dal.run(`
    INSERT INTO reconciliations (account_id, period_start, period_end, statement_balance, system_balance, difference, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [accountId, req.body.period_start, req.body.period_end, statementBalance, systemBalance, statementBalance - systemBalance, req.body.notes || null, req.session.user.id]);

  // Mark all posted transactions for this account within the period as reconciled
  // ONLY if the difference is zero (statement matches system)
  const difference = statementBalance - systemBalance;
  let markCount = 0;
  if (difference === 0) {
    const markResult = await dal.run(`
      UPDATE transactions
      SET reconciled = true, updated_at = NOW()
      WHERE account_id = $1
        AND status = 'posted'
        AND reconciled = false
        AND tx_date >= $2
        AND tx_date <= $3
    `, [accountId, req.body.period_start, req.body.period_end]);
    markCount = markResult.rowCount;
    console.log(`[reconciliation] Marked ${markCount} transactions as reconciled for account ${accountId} (${req.body.period_start} to ${req.body.period_end})`);
  } else {
    console.log(`[reconciliation] Difference is ${difference} — transactions NOT marked as reconciled. Resolve the difference first.`);
  }

  await dal.audit(req.session.user.id, 'create', 'reconciliation', result.rows[0].id, { period_end: req.body.period_end, transactions_reconciled: markCount, difference });
  if (difference === 0) {
    req.session.flash = { type: 'success', message: `Reconciliation balanced. ${markCount} transaction(s) marked as reconciled.` };
  } else {
    req.session.flash = { type: 'warning', message: `Reconciliation saved with a difference of ${difference.toFixed(2)}. Transactions remain unreconciled until the difference is resolved.` };
  }
  res.redirect('/reconciliation');
}));

app.post('/reconciliation/:id/edit', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const recId = Number(req.params.id);
  const existing = await dal.queryOne('SELECT * FROM reconciliations WHERE id = $1', [recId]);
  if (!existing) return res.status(404).render('error', { message: 'Reconciliation not found.' });
  const statementBalance = Number(req.body.statement_balance || 0);
  const balances = await accountBalances();
  const account = balances.find((item) => item.id === existing.account_id);
  const systemBalance = account ? account.balance : Number(existing.system_balance);
  await dal.run(`
    UPDATE reconciliations
    SET period_start = $1, period_end = $2, statement_balance = $3, system_balance = $4,
        difference = $5, notes = $6
    WHERE id = $7
  `, [
    req.body.period_start || existing.period_start,
    req.body.period_end || existing.period_end,
    statementBalance,
    systemBalance,
    statementBalance - systemBalance,
    req.body.notes || null,
    recId
  ]);
  await dal.audit(req.session.user.id, 'update', 'reconciliation', recId, { period_end: req.body.period_end, statement_balance: statementBalance });
  req.session.flash = { type: 'success', message: 'Reconciliation updated.' };
  res.redirect('/reconciliation');
}));

app.post('/reconciliation/:id/delete', allow('admin', 'treasurer'), asyncHandler(async (req, res) => {
  const recId = Number(req.params.id);
  const existing = await dal.queryOne('SELECT * FROM reconciliations WHERE id = $1', [recId]);
  if (!existing) return res.status(404).render('error', { message: 'Reconciliation not found.' });

  // Un-reconcile transactions that were marked by this reconciliation period
  await dal.run(`
    UPDATE transactions
    SET reconciled = false, updated_at = NOW()
    WHERE account_id = $1
      AND status = 'posted'
      AND reconciled = true
      AND tx_date >= $2
      AND tx_date <= $3
  `, [existing.account_id, existing.period_start, existing.period_end]);

  await dal.run('DELETE FROM reconciliations WHERE id = $1', [recId]);
  await dal.audit(req.session.user.id, 'delete', 'reconciliation', recId, { account_id: existing.account_id, period_end: existing.period_end });
  req.session.flash = { type: 'success', message: 'Reconciliation deleted and transactions marked as unreconciled.' };
  res.redirect('/reconciliation');
}));

app.get('/reports', requireLogin, asyncHandler(async (req, res) => {
  const year = Number(req.query.year || selectedYear(req));
  const period = monthPeriod(year, req.query.month);
  const summary = await reportSummary(period.startDate, period.endDate);
  const arrears = await arrearsReport(year);
  const incomeByCategory = await dal.query(`
    SELECT t.category, COALESCE(SUM(t.amount - t.welfare_component), 0) AS total
    FROM transactions t
    JOIN transaction_categories tc ON tc.name = t.category
    WHERE t.tx_type = 'receipt' AND t.status = 'posted'
      AND tc.purpose != 'welfare_income'
      AND t.tx_date >= $1
      AND t.tx_date <= $2
    GROUP BY t.category
    HAVING SUM(t.amount - t.welfare_component) > 0
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
  const active = await dal.queryOne("SELECT year FROM fiscal_years WHERE status = 'open' AND is_active = true LIMIT 1");
  if (!active && !req.query.year) return res.status(409).json({ error: 'No active fiscal year has been selected.' });
  const year = Number(req.query.year || active.year);
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

app.get('/trustee-dashboard', allow('admin', 'trustee', 'auditor'), asyncHandler(async (req, res) => {
  const balances = await accountBalances();
  const latestAudit = await latestCompletedAudit();

  // Handle no-open-fiscal-year gracefully
  if (!req.activeFiscalYear) {
    return res.render('trustee_dashboard', {
      balances,
      grossReceipts: null,
      totalOutflows: null,
      unreconciledCount: null,
      latestAudit,
      noActiveFiscalYear: true
    });
  }

  const year = Number(req.activeFiscalYear.year);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  // Load fiscal year summary (receipts and outflows)
  const summaryRow = await dal.queryOne(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE tx_type = 'receipt'), 0) AS receipts,
      COALESCE(SUM(amount) FILTER (WHERE tx_type IN ('expense', 'welfare_payout')), 0) AS outflows
    FROM transactions
    WHERE status = 'posted' AND tx_date >= $1 AND tx_date <= $2
  `, [yearStart, yearEnd]);

  const grossReceipts = Number(summaryRow.receipts || 0);
  const totalOutflows = Number(summaryRow.outflows || 0);

  // Unreconciled transaction count for the current fiscal year
  const unreconciledRow = await dal.queryOne(`
    SELECT COUNT(*)::int AS count
    FROM transactions
    WHERE status = 'posted' AND tx_type <> 'transfer' AND reconciled = false
      AND tx_date >= $1 AND tx_date <= $2
  `, [yearStart, yearEnd]);
  const unreconciledCount = Number(unreconciledRow.count || 0);

  res.render('trustee_dashboard', {
    balances,
    grossReceipts,
    totalOutflows,
    unreconciledCount,
    latestAudit,
    noActiveFiscalYear: false
  });
}));

app.get('/trustee-audit', allow('admin', 'auditor', 'trustee', 'treasurer'), asyncHandler(async (req, res) => {
  const years = await dal.query('SELECT year, status FROM fiscal_years ORDER BY year DESC');
  const requestedYear = Number(req.query.year || selectedYear(req));
  const year = years.some((item) => Number(item.year) === requestedYear) ? requestedYear : selectedYear(req);
  const [evidence, budget, review] = await Promise.all([
    auditEvidence(year),
    budgetVsActual(year),
    dal.queryOne(`
      SELECT r.*, starter.name AS started_by_name, completer.name AS completed_by_name
      FROM audit_reviews r
      LEFT JOIN users starter ON starter.id=r.started_by
      LEFT JOIN users completer ON completer.id=r.completed_by
      WHERE r.year=$1
    `, [year])
  ]);
  const items = review ? await dal.query(`
    SELECT i.*, u.name AS reviewed_by_name
    FROM audit_review_items i LEFT JOIN users u ON u.id=i.reviewed_by
    WHERE i.review_id=$1 ORDER BY i.id
  `, [review.id]) : [];
  const itemByKey = Object.fromEntries(items.map((item) => [item.item_key, item]));
  res.render('trustee_audit', {
    year, years, evidence, budget, review, checklist: AUDIT_CHECKLIST, itemByKey,
    canReview: ['auditor', 'trustee'].includes(req.session.user.role)
  });
}));

app.post('/trustee-audit/start', allow('auditor', 'trustee'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const fiscalYear = await dal.queryOne('SELECT * FROM fiscal_years WHERE year=$1', [year]);
  if (!fiscalYear) return res.status(404).render('error', { message: 'Fiscal year not found.' });
  const existing = await dal.queryOne('SELECT id FROM audit_reviews WHERE year=$1', [year]);
  if (existing) {
    req.session.flash = { type: 'error', message: 'An audit review already exists for this fiscal year.' };
    return res.redirect(`/trustee-audit?year=${year}`);
  }
  await dal.transaction(async (client) => {
    const result = await client.query(`
      INSERT INTO audit_reviews (year, scope_start, scope_end, started_by)
      VALUES ($1,$2,$3,$4) RETURNING id
    `, [year, `${year}-01-01`, `${year}-12-31`, req.session.user.id]);
    for (const item of AUDIT_CHECKLIST) {
      await client.query('INSERT INTO audit_review_items (review_id, item_key) VALUES ($1,$2)', [result.rows[0].id, item.key]);
    }
    await dal.audit(req.session.user.id, 'start', 'audit_review', result.rows[0].id, { year },
      { client, ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  });
  req.session.flash = { type: 'success', message: `Trustee audit for ${year} started.` };
  res.redirect(`/trustee-audit?year=${year}`);
}));

app.post('/trustee-audit/items/:key', allow('auditor', 'trustee'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const definition = AUDIT_CHECKLIST.find((item) => item.key === req.params.key);
  if (!definition) return res.status(404).render('error', { message: 'Audit checklist item not found.' });
  const validated = validateAuditItem(req.body);
  if (validated.errors.length) {
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect(`/trustee-audit?year=${year}`);
  }
  const review = await dal.queryOne("SELECT * FROM audit_reviews WHERE year=$1 AND status='in_progress'", [year]);
  if (!review) return res.status(409).render('error', { message: 'This audit is not open for review.' });
  const existingItem = await dal.queryOne('SELECT * FROM audit_review_items WHERE review_id=$1 AND item_key=$2', [review.id, definition.key]);
  if (!existingItem) return res.status(404).render('error', { message: 'Audit checklist item not found.' });
  const result = await dal.run(`
    UPDATE audit_review_items SET status=$1, notes=$2, reviewed_by=$3, reviewed_at=NOW()
    WHERE review_id=$4 AND item_key=$5 RETURNING id
  `, [validated.values.status, validated.values.notes || null, req.session.user.id, review.id, definition.key]);
  if (!result.rowCount) return res.status(404).render('error', { message: 'Audit checklist item not found.' });
  await dal.audit(req.session.user.id, 'review', 'audit_review_item', result.rows[0].id,
    { year, item: definition.key, ...validated.values },
    {
      before_value: existingItem, after_value: { ...existingItem, ...validated.values, reviewed_by: req.session.user.id },
      ip_address: getClientIp(req), user_agent: req.get('user-agent')
    });
  req.session.flash = { type: 'success', message: `${definition.label} review saved.` };
  res.redirect(`/trustee-audit?year=${year}`);
}));

app.post('/trustee-audit/flag-transaction', allow('auditor', 'trustee'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const validated = validateAuditFlag(req.body);
  if (validated.errors.length) {
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect(`/trustee-audit?year=${year}`);
  }
  const review = await dal.queryOne("SELECT * FROM audit_reviews WHERE year=$1 AND status='in_progress'", [year]);
  if (!review) return res.status(409).render('error', { message: 'No active audit review. Start an audit before flagging transactions.' });
  await dal.createAuditFlag(review.id, validated.values.transaction_id, validated.values.reason, req.session.user.id);
  req.session.flash = { type: 'success', message: 'Transaction flagged for investigation.' };
  res.redirect(`/trustee-audit?year=${year}`);
}));

app.get('/trustee-audit/flagged', allow('admin', 'auditor', 'trustee', 'treasurer'), asyncHandler(async (req, res) => {
  const year = Number(req.query.year || selectedYear(req));
  const review = await dal.queryOne("SELECT * FROM audit_reviews WHERE year=$1", [year]);
  if (!review) {
    return res.json({ flags: [], message: 'No audit review found for this year.' });
  }
  const flags = await dal.getAuditFlags(review.id);
  res.json({ flags, year, reviewId: review.id });
}));

// --- Transaction Investigation Routes (Task 9.4) ---

app.get('/trustee-audit/transaction/:id', allow('admin', 'trustee', 'auditor'), asyncHandler(async (req, res) => {
  const txId = Number(req.params.id);
  const transaction = await dal.queryOne(`
    SELECT t.*, m.name AS member_name, a.name AS account_name, u.name AS recorded_by_name
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.id = $1
  `, [txId]);
  if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });

  // Load any investigation notes for this transaction (from the current active or most recent review)
  const review = await dal.queryOne(
    "SELECT id FROM audit_reviews WHERE status IN ('in_progress', 'completed') ORDER BY year DESC LIMIT 1"
  );
  const notes = review ? await dal.getTransactionNotes(review.id, txId) : [];

  res.json({ transaction, notes });
}));

app.get('/trustee-audit/transactions', allow('admin', 'trustee', 'auditor'), asyncHandler(async (req, res) => {
  const { tx_type, account_id, reconciled, date_start, date_end } = req.query;

  const conditions = ["t.status = 'posted'"];
  const params = [];
  let paramIndex = 1;

  if (tx_type) {
    conditions.push(`t.tx_type = $${paramIndex++}`);
    params.push(tx_type);
  }
  if (account_id) {
    conditions.push(`t.account_id = $${paramIndex++}`);
    params.push(Number(account_id));
  }
  if (reconciled !== undefined && reconciled !== '') {
    conditions.push(`t.reconciled = $${paramIndex++}`);
    params.push(reconciled === 'true');
  }
  if (date_start) {
    conditions.push(`t.tx_date >= $${paramIndex++}`);
    params.push(date_start);
  }
  if (date_end) {
    conditions.push(`t.tx_date <= $${paramIndex++}`);
    params.push(date_end);
  }

  const rows = await dal.query(`
    SELECT t.*, m.name AS member_name, a.name AS account_name
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.tx_date DESC, t.id DESC
    LIMIT 200
  `, params);

  res.json({ transactions: rows, count: rows.length });
}));

app.post('/trustee-audit/transaction/:id/note', allow('admin', 'trustee', 'auditor'), asyncHandler(async (req, res) => {
  const txId = Number(req.params.id);

  // Validate the note text
  const validated = validateTransactionNote(req.body);
  if (validated.errors.length) {
    if (req.get('Accept') === 'application/json' || req.xhr) {
      return res.status(400).json({ errors: validated.errors });
    }
    req.session.flash = { type: 'error', message: validated.errors.join(' ') };
    return res.redirect('back');
  }

  // Ensure transaction exists
  const transaction = await dal.queryOne('SELECT id FROM transactions WHERE id = $1', [txId]);
  if (!transaction) {
    if (req.get('Accept') === 'application/json' || req.xhr) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }
    return res.status(404).render('error', { message: 'Transaction not found.' });
  }

  // Find active or most recent review to attach the note to
  const review = await dal.queryOne(
    "SELECT id FROM audit_reviews WHERE status = 'in_progress' ORDER BY year DESC LIMIT 1"
  );
  if (!review) {
    if (req.get('Accept') === 'application/json' || req.xhr) {
      return res.status(400).json({ error: 'No active audit review. Start an audit before adding notes.' });
    }
    req.session.flash = { type: 'error', message: 'No active audit review. Start an audit before adding notes.' };
    return res.redirect('back');
  }

  const note = await dal.createTransactionNote(review.id, txId, validated.values.note, req.session.user.id);

  if (req.get('Accept') === 'application/json' || req.xhr) {
    return res.status(201).json({ note });
  }
  req.session.flash = { type: 'success', message: 'Investigation note added.' };
  res.redirect('back');
}));

app.get('/trustee-audit/period-comparison', allow('admin', 'trustee', 'auditor'), asyncHandler(async (req, res) => {
  const year = Number(req.query.year || selectedYear(req));
  const comparison = await periodComparison(year);
  res.json({ year, comparison });
}));

app.post('/trustee-audit/complete', allow('auditor', 'trustee'), asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const review = await dal.queryOne("SELECT * FROM audit_reviews WHERE year=$1 AND status='in_progress'", [year]);
  if (!review) return res.status(409).render('error', { message: 'This audit is not open for completion.' });

  // Load checklist items and validate all have been reviewed
  const items = await dal.query('SELECT item_key AS key, status FROM audit_review_items WHERE review_id=$1', [review.id]);
  const unreviewed = validateAuditCompletion(items, AUDIT_CHECKLIST.length);
  if (unreviewed.length > 0) {
    const unreviewedLabels = unreviewed.map(key => {
      const def = AUDIT_CHECKLIST.find(c => c.key === key);
      return def ? def.label : key;
    });
    req.session.flash = { type: 'error', message: `Complete all checklist items before finishing the audit. Unreviewed: ${unreviewedLabels.join(', ')}` };
    return res.redirect(`/trustee-audit?year=${year}`);
  }

  // Validate the conclusion text
  const conclusionValidated = validateAuditConclusion(req.body);
  if (conclusionValidated.errors.length) {
    req.session.flash = { type: 'error', message: conclusionValidated.errors.join(' ') };
    return res.redirect(`/trustee-audit?year=${year}`);
  }

  await dal.transaction(async (client) => {
    await client.query(
      `UPDATE audit_reviews SET status='completed', overall_conclusion=$1, overall_notes=$2, completed_by=$3, completed_at=NOW() WHERE id=$4`,
      [conclusionValidated.values.conclusion, conclusionValidated.values.conclusion, req.session.user.id, review.id]
    );
    await dal.audit(req.session.user.id, 'complete', 'audit_review', review.id, { year, conclusion: conclusionValidated.values.conclusion },
      { client, ip_address: getClientIp(req), user_agent: req.get('user-agent') });
  });
  req.session.flash = { type: 'success', message: `Trustee audit for ${year} completed and signed.` };
  res.redirect(`/trustee-audit?year=${year}`);
}));

app.get('/trustee-audit/report/:year', allow('admin', 'trustee', 'auditor'), asyncHandler(async (req, res) => {
  const PDFDocument = require('pdfkit');
  const year = Number(req.params.year);
  if (!year || year < 1900 || year > 2100) {
    return res.status(400).render('error', { message: 'Invalid year.' });
  }

  // Load audit review for the given year
  const review = await dal.queryOne(`
    SELECT r.*, starter.name AS started_by_name, completer.name AS completed_by_name
    FROM audit_reviews r
    LEFT JOIN users starter ON starter.id = r.started_by
    LEFT JOIN users completer ON completer.id = r.completed_by
    WHERE r.year = $1
  `, [year]);
  if (!review) {
    return res.status(404).render('error', { message: `No audit review found for ${year}.` });
  }

  // Load checklist items, flagged transactions, and account balances
  const [items, flags, balances] = await Promise.all([
    dal.query(`
      SELECT i.*, u.name AS reviewed_by_name
      FROM audit_review_items i
      LEFT JOIN users u ON u.id = i.reviewed_by
      WHERE i.review_id = $1
      ORDER BY i.id
    `, [review.id]),
    dal.getAuditFlags(review.id),
    accountBalances(`${year}-12-31`),
  ]);

  // Generate PDF
  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="audit-report-${year}.pdf"`);
  doc.pipe(res);

  // Title
  doc.fontSize(20).font('Helvetica-Bold').text(`Audit Report — ${year}`, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toISOString().slice(0, 10)}`, { align: 'center' });
  if (review.completed_by_name) {
    doc.text(`Signed by: ${review.completed_by_name}`, { align: 'center' });
  }
  doc.text(`Status: ${review.status}`, { align: 'center' });
  doc.moveDown(1.5);

  // Section: Checklist Outcomes
  doc.fontSize(14).font('Helvetica-Bold').text('Checklist Outcomes');
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  for (const item of items) {
    const definition = AUDIT_CHECKLIST.find(c => c.key === item.item_key);
    const label = definition ? definition.label : item.item_key;
    const status = (item.status || 'pending').toUpperCase();
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
    doc.font('Helvetica').text(status);
    if (item.notes) {
      doc.fontSize(9).text(`   Notes: ${item.notes}`, { indent: 20 });
      doc.fontSize(10);
    }
    if (item.reviewed_by_name) {
      doc.fontSize(9).text(`   Reviewed by: ${item.reviewed_by_name}`, { indent: 20 });
      doc.fontSize(10);
    }
    doc.moveDown(0.3);
  }
  doc.moveDown(1);

  // Section: Flagged Transactions
  doc.fontSize(14).font('Helvetica-Bold').text('Flagged Transactions');
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  if (flags.length === 0) {
    doc.text('No transactions were flagged during this audit.');
  } else {
    for (const flag of flags) {
      doc.font('Helvetica-Bold').text(`Transaction #${flag.transaction_id}`, { continued: true });
      doc.font('Helvetica').text(` — ${flag.reason}`);
      if (flag.flagged_by_name) {
        doc.fontSize(9).text(`   Flagged by: ${flag.flagged_by_name}`, { indent: 20 });
        doc.fontSize(10);
      }
      doc.moveDown(0.3);
    }
  }
  doc.moveDown(1);

  // Section: Account Balances
  doc.fontSize(14).font('Helvetica-Bold').text(`Account Balances (as at ${year}-12-31)`);
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  if (balances.length === 0) {
    doc.text('No active accounts found.');
  } else {
    for (const acct of balances) {
      const bal = Number(acct.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      doc.text(`${acct.name}: ${bal}`);
    }
  }
  doc.moveDown(1);

  // Section: Conclusion
  doc.fontSize(14).font('Helvetica-Bold').text('Conclusion');
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  const conclusion = review.overall_notes || review.overall_conclusion || 'No conclusion recorded.';
  doc.text(conclusion);

  doc.end();
}));

app.get('/audit', allow('admin', 'auditor', 'trustee'), asyncHandler(async (req, res) => {
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
  res.render('download_reports', { year: selectedYear(req), members });
}));

// Downloadable report endpoints
app.get('/download/income-expenditure', requireLogin, asyncHandler(async (req, res) => {
  try {
    const year = Number(req.query.year || selectedYear(req));
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
    const year = Number(req.query.year || selectedYear(req));
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
    const year = Number(req.query.year || selectedYear(req));
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
    const year = Number(req.query.year || selectedYear(req));
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
    const year = Number(req.query.year || selectedYear(req));
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
    const year = Number(req.query.year || selectedYear(req));
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
    const year = Number(req.query.year || selectedYear(req));
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
    const year = Number(req.query.year || selectedYear(req));
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

app.get('/export/budget-actual', allow('admin', 'finance_secretary', 'treasurer', 'auditor', 'trustee', 'viewer'), asyncHandler(async (req, res) => {
  try {
    const year = Number(req.query.year || selectedYear(req));
    const csv = await exportBudgetActualCsv(year);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="budget-vs-actual-${year}.csv"`);
    res.send(csv);
    await dal.audit(req.session.user.id, 'export', 'budget_actual', null, `Year ${year}`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).render('error', { message: 'Failed to export budget versus actual.' });
  }
}));

app.get('/export/audit-log', allow('admin', 'auditor', 'trustee'), asyncHandler(async (req, res) => {
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
