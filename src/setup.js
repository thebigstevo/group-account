'use strict';

const express = require('express');
const crypto = require('crypto');
const dal = require('./dal');
const { hashPassword } = require('./security');

const router = express.Router();

function setupCsrf(req, res, next) {
  if (!req.session._csrf) req.session._csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session._csrf;
  if (req.method === 'POST' && (!req.body._csrf || req.body._csrf !== req.session._csrf)) {
    return res.status(403).render('setup', {
      title: 'Initial Setup',
      error: 'Form expired. Please reload setup and try again.',
      values: req.body || {}
    });
  }
  next();
}

router.use('/setup', setupCsrf);

/**
 * Check if the application needs initial setup (no users exist).
 * Returns true if setup is required.
 */
async function isSetupRequired() {
  try {
    const result = await dal.queryOne('SELECT COUNT(*)::int AS count FROM users');
    return result.count === 0;
  } catch (err) {
    // Table might not exist yet (migration not run) — setup not applicable
    return false;
  }
}

/**
 * Middleware that redirects to /setup if no users exist.
 * Skips for /setup routes, /health, and static assets.
 */
async function setupGuard(req, res, next) {
  // Skip for setup routes, health check, and static files
  if (req.path.startsWith('/setup') || req.path === '/health' || req.path.startsWith('/app.')) {
    return next();
  }

  const needsSetup = await isSetupRequired();
  if (needsSetup) {
    return res.redirect('/setup');
  }
  next();
}

// GET /setup — Show setup wizard
router.get('/setup', async (req, res) => {
  const needsSetup = await isSetupRequired();
  if (!needsSetup) {
    return res.redirect('/login');
  }

  res.render('setup', {
    title: 'Initial Setup',
    error: null,
    values: {}
  });
});

// POST /setup — Process setup wizard
router.post('/setup', async (req, res) => {
  const needsSetup = await isSetupRequired();
  if (!needsSetup) {
    return res.redirect('/login');
  }

  const { admin_name, admin_email, admin_password, confirm_password, group_name, currency, fiscal_year } = req.body;
  const errors = [];

  // Validation
  if (!admin_name || admin_name.trim().length < 2) {
    errors.push('Admin name must be at least 2 characters.');
  }
  if (!admin_email || !admin_email.includes('@')) {
    errors.push('A valid email address is required.');
  }
  if (!admin_password || admin_password.length < 8) {
    errors.push('Password must be at least 8 characters.');
  }
  if (admin_password !== confirm_password) {
    errors.push('Passwords do not match.');
  }
  const cleanGroupName = String(group_name || '').trim();
  const cleanCurrency = String(currency || 'GHS').trim().toUpperCase();
  const year = Number(fiscal_year) || new Date().getFullYear();
  if (!cleanGroupName) errors.push('Organization name is required.');
  if (!/^[A-Z]{3}$/.test(cleanCurrency)) errors.push('Select a valid three-letter currency code.');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push('Select a valid fiscal year.');

  if (errors.length > 0) {
    return res.render('setup', {
      title: 'Initial Setup',
      error: errors.join(' '),
      values: req.body
    });
  }

  try {
    const adminId = await dal.transaction(async (client) => {
      // Serialize concurrent setup attempts and re-check inside the transaction.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('treasurio-initial-setup', 0))");
      const userCount = await client.query('SELECT COUNT(*)::int AS count FROM users');
      if (userCount.rows[0].count !== 0) throw new Error('SETUP_ALREADY_COMPLETED');

      const result = await client.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'admin') RETURNING id`,
        [admin_name.trim(), admin_email.trim().toLowerCase(), hashPassword(admin_password)]
      );
      const createdAdminId = result.rows[0].id;
      await client.query('UPDATE fiscal_years SET is_active = false WHERE is_active = true');
      await client.query(
        `INSERT INTO fiscal_years (year, status, is_active)
         VALUES ($1, 'open', true)
         ON CONFLICT (year) DO UPDATE SET status = 'open', is_active = true`,
        [year]
      );
      await client.query(
        `INSERT INTO organization_settings (id, name, currency)
         VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, currency = EXCLUDED.currency, updated_at = NOW()`,
        [cleanGroupName, cleanCurrency]
      );
      await dal.audit(createdAdminId, 'setup', 'system', null,
        { admin_email: admin_email.trim().toLowerCase(), organization: cleanGroupName, currency: cleanCurrency, fiscal_year: year },
        { client });
      return createdAdminId;
    });

    // Rotate the anonymous setup session before granting administrator access.
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    const commandery = await dal.queryOne('SELECT id FROM commanderies WHERE active = true ORDER BY id LIMIT 1');
    req.session.user = {
      id: adminId,
      name: admin_name.trim(),
      email: admin_email.trim().toLowerCase(),
      role: 'admin',
      commandery_id: commandery ? commandery.id : null
    };

    res.redirect('/');
  } catch (err) {
    console.error('Setup error:', err.message);
    if (err.message === 'SETUP_ALREADY_COMPLETED') return res.redirect('/login');
    res.render('setup', {
      title: 'Initial Setup',
      error: 'Setup could not be completed. Please try again or contact the system administrator.',
      values: req.body
    });
  }
});

module.exports = { router, setupGuard, isSetupRequired };
