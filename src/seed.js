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

  const year = new Date().getFullYear();
  const rulesResult = await dal.queryOne(
    'SELECT COUNT(*) AS count FROM dues_rules WHERE year = $1',
    [year]
  );
  const rules = Number(rulesResult.count);

  if (rules === 0) {
    await dal.run(
      `INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [year, 'Standard members', null, 59, 700, 300]
    );
    await dal.run(
      `INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [year, 'Age 60 to 69', 60, 69, 350, 150]
    );
    await dal.run(
      `INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [year, 'Age 70 and above', 70, null, 0, 0]
    );
  }

  const splitsResult = await dal.queryOne(
    'SELECT COUNT(*) AS count FROM payment_splits WHERE year = $1',
    [year]
  );
  const splits = Number(splitsResult.count);

  if (splits === 0) {
    await dal.run(
      `INSERT INTO payment_splits (year, category, assessment_amount, welfare_amount)
       VALUES ($1, $2, $3, $4)`,
      [year, 'Assessment', 700, 300]
    );
  }

  console.log('Seed complete. Login with admin@example.com / ChangeMe123!');
  await dal.shutdown();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
