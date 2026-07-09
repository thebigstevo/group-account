const { db, audit } = require('./db');
const { hashPassword } = require('./security');

const existing = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

if (existing === 0) {
  const admin = db.prepare(`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (?, ?, ?, ?)
  `).run('System Admin', 'admin@example.com', hashPassword('ChangeMe123!'), 'admin');
  audit(admin.lastInsertRowid, 'seed', 'user', admin.lastInsertRowid, 'Default admin user');
}

const year = new Date().getFullYear();
const rules = db.prepare('SELECT COUNT(*) AS count FROM dues_rules WHERE year = ?').get(year).count;
if (rules === 0) {
  const insert = db.prepare(`
    INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(year, 'Standard members', null, 59, 700, 300);
  insert.run(year, 'Age 60 to 69', 60, 69, 350, 150);
  insert.run(year, 'Age 70 and above', 70, null, 0, 0);
}

const splits = db.prepare('SELECT COUNT(*) AS count FROM payment_splits WHERE year = ?').get(year).count;
if (splits === 0) {
  db.prepare(`
    INSERT INTO payment_splits (year, category, assessment_amount, welfare_amount)
    VALUES (?, ?, ?, ?)
  `).run(year, 'Assessment', 700, 300);
}

console.log('Seed complete. Login with admin@example.com / ChangeMe123!');
