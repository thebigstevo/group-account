const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
const setupSource = fs.readFileSync(path.join(root, 'src', 'setup.js'), 'utf8');
const backupSource = fs.readFileSync(path.join(root, 'deploy', 'backup.sh'), 'utf8');
const composeSource = fs.readFileSync(path.join(root, 'deploy', 'docker-compose.yml'), 'utf8');
const devDeploySource = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-dev.yml'), 'utf8');
const prodDeploySource = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-prod.yml'), 'utf8');

describe('production security contracts', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('production refuses weak session and API secrets', () => {
    process.env.NODE_ENV = 'production';
    process.env.PGHOST = 'postgres';
    process.env.PGDATABASE = 'treasurio_prod';
    process.env.PGUSER = 'treasurio_prod';
    process.env.SESSION_SECRET = 'short';
    process.env.N8N_API_TOKEN = 'prod-token';
    jest.resetModules();
    expect(() => require('../config')).toThrow(/SESSION_SECRET/);

    process.env.SESSION_SECRET = 's'.repeat(32);
    jest.resetModules();
    expect(() => require('../config')).toThrow(/N8N_API_TOKEN/);

    process.env.N8N_API_TOKEN = 'n'.repeat(32);
    process.env.PGPASSWORD = 'short';
    jest.resetModules();
    expect(() => require('../config')).toThrow(/PGPASSWORD/);
  });

  test('attachments are protected by authorized download routes and not public static hosting', () => {
    expect(serverSource).not.toContain("app.use('/uploads', express.static(uploadsDir))");
    expect(serverSource).toContain("app.get('/attachments/:id/download', allow('admin', 'finance_secretary', 'treasurer', 'auditor', 'trustee')");
    expect(serverSource).toContain('validateUploadedFile(req.file)');
  });

  test('login rotates sessions and auditors cannot modify reconciliation state', () => {
    expect(serverSource).toContain('req.session.regenerate');
    expect(serverSource).toContain("app.post('/transactions/:id/reconcile', allow('admin', 'finance_secretary', 'treasurer')");
  });

  test('setup is CSRF-protected, atomic, and activates the configured fiscal year', () => {
    expect(setupSource).toContain("router.use('/setup', setupCsrf)");
    expect(setupSource).toContain('dal.transaction(async (client)');
    expect(setupSource).toContain("VALUES ($1, 'open', true)");
    expect(setupSource).toContain('INSERT INTO organization_settings');
    expect(setupSource).not.toContain("error: 'Setup failed: ' + err.message");
  });

  test('runtime app containers use separate database roles', () => {
    expect(composeSource).toContain('PGUSER: treasurio_dev');
    expect(composeSource).toContain('PGUSER: treasurio_prod');
  });

  test('backup covers databases and upload volumes and verifies S3 objects', () => {
    expect(backupSource).toContain('pg_dump -U treasurio -d treasurio_dev');
    expect(backupSource).toContain('${COMPOSE_PROJECT_NAME}_uploads-dev');
    expect(backupSource).toContain('${COMPOSE_PROJECT_NAME}_uploads-prod');
    expect(backupSource).toContain('aws s3api head-object');
    expect(backupSource).toContain('--metadata "sha256=${checksum}"');
    expect(backupSource).toContain('remote_checksum');
    expect(backupSource).toContain('extension="tar.gz"');
  });

  test('GitOps uploads the tested checkout and does not require anonymous server-side GitHub access', () => {
    for (const workflow of [devDeploySource, prodDeploySource]) {
      expect(workflow).toContain('uses: appleboy/scp-action@v1');
      expect(workflow).toContain('Uploaded release SHA does not match');
      expect(workflow).toContain('.release-sha');
      expect(workflow).not.toContain('git fetch origin');
      expect(workflow).not.toContain('git clone -b');
    }
  });

  test('setup and organization forms do not expose secrets and include CSRF', async () => {
    const setup = await ejs.renderFile(path.join(root, 'src', 'views', 'setup.ejs'), {
      csrfToken: 'setup-token', error: null, values: {}
    });
    expect(setup).toContain('name="_csrf" value="setup-token"');

    const organizationTemplate = fs.readFileSync(path.join(root, 'src', 'views', 'organization.ejs'), 'utf8');
    expect(organizationTemplate).not.toContain('value="<%= org.sms_api_key');
    expect(organizationTemplate).toContain('leave blank to keep the current key');
  });
});
