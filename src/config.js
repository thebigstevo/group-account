const path = require('path');

const rootDir = path.resolve(__dirname, '..');

module.exports = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  n8nApiToken: process.env.N8N_API_TOKEN || 'dev-n8n-token',
  dbPath: process.env.DB_PATH || path.join(rootDir, 'storage', 'accounts.db'),
  secureCookies: process.env.SECURE_COOKIES === '1',
  requireSecret: process.env.NODE_ENV === 'production'
};
