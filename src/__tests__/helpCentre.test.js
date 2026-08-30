'use strict';

const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { ALL_ROLES, helpForRole } = require('../helpContent');

const root = path.join(__dirname, '..');
const views = path.join(root, 'views');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const baseLocals = {
  currentPath: '/help', csrfToken: 'csrf', groupName: 'Test Commandery', groupCurrency: 'GHS',
  assetVersion: 'test', activeFiscalYear: { year: 2026 }, title: 'Help',
  formatMoney: (value) => `GHS ${Number(value || 0).toFixed(2)}`, formatDate: String, formatDateTime: String
};

describe('role-aware in-application help centre', () => {
  test.each(ALL_ROLES)('%s receives a useful role guide', (role) => {
    const guide = helpForRole(role);
    expect(guide.role).toBe(role);
    expect(guide.roleLabel).toBeTruthy();
    expect(guide.startMessage).toBeTruthy();
    expect(guide.topics.length).toBeGreaterThanOrEqual(3);
    expect(guide.topics.every((topic) => topic.roles.includes(role))).toBe(true);
  });

  test('administrator setup and user controls are hidden from every other role', () => {
    const restricted = ['fresh-installation', 'organization-settings', 'users-and-security'];
    expect(helpForRole('admin').topics.map((topic) => topic.id)).toEqual(expect.arrayContaining(restricted));
    ALL_ROLES.filter((role) => role !== 'admin').forEach((role) => {
      expect(helpForRole(role).topics.map((topic) => topic.id).some((id) => restricted.includes(id))).toBe(false);
    });
  });

  test('step links are filtered where a topic has different permissions', () => {
    const treasurerAudit = helpForRole('treasurer').topics.find((topic) => topic.id === 'audit');
    const auditorAudit = helpForRole('auditor').topics.find((topic) => topic.id === 'audit');
    expect(treasurerAudit.steps.map((step) => step.href)).not.toContain('/audit');
    expect(auditorAudit.steps.map((step) => step.href)).toContain('/audit');
  });

  test('search only returns matching topics already allowed for the role', () => {
    expect(helpForRole('admin', 'fresh installation').topics.map((topic) => topic.id)).toContain('fresh-installation');
    expect(helpForRole('viewer', 'fresh installation').topics).toHaveLength(0);
    expect(helpForRole('treasurer', 'reconcile').topics.map((topic) => topic.id)).toContain('reconciliation');
  });

  test('unknown roles fail safely to the read-only viewer guide', () => {
    const guide = helpForRole('unexpected-role');
    expect(guide.role).toBe('viewer');
    expect(guide.topics.some((topic) => topic.id === 'fresh-installation')).toBe(false);
  });

  test('help page renders search, print, role label, navigation, and direct task links', async () => {
    const user = { id: 1, name: 'System Admin', role: 'admin' };
    const html = await ejs.renderFile(path.join(views, 'help.ejs'), { ...baseLocals, user, guide: helpForRole(user.role) });
    expect(html).toContain('<h1>Help &amp; User Guide</h1>');
    expect(html).toContain('Simple instructions for your <strong>Administrator</strong> role.');
    expect(html).toContain('role="search"');
    expect(html).toContain('data-print');
    expect(html).toContain('href="/organization"');
    expect(html).toContain('href="#fresh-installation"');
    expect(html).toContain('</html>');
  });

  test('viewer rendering contains no administrator-only text or links', async () => {
    const user = { id: 2, name: 'Read Only', role: 'viewer' };
    const html = await ejs.renderFile(path.join(views, 'help.ejs'), { ...baseLocals, user, guide: helpForRole(user.role) });
    expect(html).toContain('Read-only Viewer');
    expect(html).not.toContain('fresh installation checklist');
    expect(html).not.toContain('href="/users"');
    expect(html).not.toContain('href="/organization"');
  });

  test('route is authenticated and remains available before fiscal-year setup', () => {
    expect(serverSource).toContain("app.get('/help', requireLogin");
    expect(serverSource).toContain("req.path === '/help'");
  });

  test('sidebar exposes Help & Guide to every signed-in role', async () => {
    for (const role of ALL_ROLES) {
      const html = await ejs.renderFile(path.join(views, 'partials', 'sidebar.ejs'), { ...baseLocals, user: { id: 1, name: 'Role Test', role } });
      expect(html).toContain('href="/help"');
      expect(html).toContain('Help &amp; Guide');
    }
  });
});
