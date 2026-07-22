// src/auth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

if (!JWT_SECRET || JWT_SECRET === 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET') {
  console.error(
    '\n[FATAL] JWT_SECRET is not set (or still the placeholder) in your .env file.\n' +
    'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
    'Then put it in .env as JWT_SECRET=...\n'
  );
  process.exit(1);
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

// Full-access token used for normal logged-in sessions.
function signSessionToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, mustChangePassword: !!user.must_change_password },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Very short-lived, narrow-scope token issued ONLY when a temporary
// super-admin credential (or any must-change-password account) logs in.
// It can ONLY be used to call /api/auth/complete-setup, nothing else.
function signSetupToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, scope: 'complete-setup' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signSessionToken,
  signSetupToken,
  verifyToken,
};
