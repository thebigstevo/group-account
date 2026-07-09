const crypto = require('crypto');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2_sha256' || !salt || !expected) return false;
  const actual = hashPassword(password, salt).split('$')[2];
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
