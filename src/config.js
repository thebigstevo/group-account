const path = require('path');

const rootDir = path.resolve(__dirname, '..');

const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  n8nApiToken: process.env.N8N_API_TOKEN || 'dev-n8n-token',
  secureCookies: process.env.SECURE_COOKIES === '1',
  requireSecret: process.env.NODE_ENV === 'production',

  // PostgreSQL connection
  databaseUrl: process.env.DATABASE_URL || null,
  pgHost: process.env.PGHOST || 'localhost',
  pgPort: Number(process.env.PGPORT || 5432),
  pgDatabase: process.env.PGDATABASE || 'treasurio',
  pgUser: process.env.PGUSER || 'treasurio',
  pgPassword: process.env.PGPASSWORD || '',
  pgPoolSize: (() => {
    const raw = Number(process.env.PG_POOL_SIZE);
    const val = Number.isFinite(raw) ? raw : 10;
    return Math.min(100, Math.max(1, Math.floor(val)));
  })(),

  // Branding
  groupName: process.env.GROUP_NAME || 'My Group',
  groupCurrency: process.env.GROUP_CURRENCY || 'GHS',
};

// Validate database configuration at startup
if (!config.databaseUrl && !(process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER)) {
  console.error(
    'Fatal: Database not configured. Set DATABASE_URL or provide PGHOST, PGDATABASE, and PGUSER environment variables.'
  );
  process.exit(1);
}

if (config.requireSecret) {
  if (config.sessionSecret === 'dev-secret-change-in-production' || config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
  }
  if (['dev-n8n-token', 'dev-token', 'prod-token'].includes(config.n8nApiToken) || config.n8nApiToken.length < 32) {
    throw new Error('N8N_API_TOKEN must be set to at least 32 characters in production');
  }
  if (!config.databaseUrl && config.pgPassword.length < 24) {
    throw new Error('PGPASSWORD must be set to at least 24 characters in production');
  }
}

module.exports = config;
