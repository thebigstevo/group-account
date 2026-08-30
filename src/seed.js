'use strict';

const dal = require('./dal');
const { hashPassword } = require('./security');

async function seed() {
  const existingResult = await dal.queryOne('SELECT COUNT(*) AS count FROM users');
  const existing = Number(existingResult.count);

  if (existing === 0) {
    const result = await dal.run(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['System Admin', 'admin@example.com', hashPassword('ChangeMe123!'), 'admin']
    );
    const adminId = result.rows[0].id;
    await dal.audit(adminId, 'seed', 'user', adminId, 'Default admin user');
  }

  console.log('Seed complete. Financial rules, categories, and accounts are configured by an administrator. Login with admin@example.com / ChangeMe123!');
  await dal.shutdown();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
