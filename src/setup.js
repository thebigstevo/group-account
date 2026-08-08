'use strict';

const express = require('express');
const dal = require('./dal');
const { hashPassword } = require('./security');

const router = express.Router();

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

  if (errors.length > 0) {
    return res.render('setup', {
      title: 'Initial Setup',
      error: errors.join(' '),
      values: req.body
    });
  }

  try {
    // Create admin user
    const result = await dal.run(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin') RETURNING id`,
      [admin_name.trim(), admin_email.trim().toLowerCase(), hashPassword(admin_password)]
    );
    const adminId = result.rows[0].id;

    // Open fiscal year if provided
    const year = Number(fiscal_year) || new Date().getFullYear();
    const existingYear = await dal.queryOne('SELECT year FROM fiscal_years WHERE year = $1', [year]);
    if (!existingYear) {
      await dal.run("INSERT INTO fiscal_years (year, status) VALUES ($1, 'open')", [year]);
    }

    // Audit the setup
    await dal.audit(adminId, 'setup', 'system', null, `Initial setup completed. Admin: ${admin_email}`);

    // Log the user in
    req.session.user = { id: adminId, name: admin_name.trim(), email: admin_email.trim().toLowerCase(), role: 'admin' };

    res.redirect('/');
  } catch (err) {
    console.error('Setup error:', err.message);
    res.render('setup', {
      title: 'Initial Setup',
      error: 'Setup failed: ' + err.message,
      values: req.body
    });
  }
});

module.exports = { router, setupGuard, isSetupRequired };
