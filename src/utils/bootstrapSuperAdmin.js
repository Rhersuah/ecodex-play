// src/utils/bootstrapSuperAdmin.js
//
// This runs automatically every time the server starts.
// If there is NOT already a super_admin account in the database, it creates
// ONE temporary account with a random username + random password, prints it
// to the console (and writes it to a local file), and flags it so that:
//   1. It can log in exactly once.
//   2. The very first thing it must do after logging in is set a REAL
//      permanent username + password (see /api/auth/complete-setup).
//   3. Once that happens, is_temp_credential is cleared forever and this
//      bootstrap function will never generate a new one again, because a
//      super_admin row now permanently exists.
//
// If you ever get locked out, run:  npm run reset-superadmin
// (this must be run directly on the server/host machine — it is not exposed
// over the network anywhere — and it only works if it deliberately removes
// the existing super_admin account first).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { hashPassword } = require('../auth');

const CREDENTIAL_FILE = path.join(__dirname, '..', '..', 'SUPERADMIN_TEMP_CREDENTIAL.txt');

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function bootstrapSuperAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'super_admin'").get();
  if (existing) return; // Already set up — never generate another temp account.

  const tempUsername = 'root_' + randomToken(4);
  const tempPassword = randomToken(12);
  const passwordHash = hashPassword(tempPassword);

  db.prepare(`
    INSERT INTO users (role, full_name, username, password_hash, must_change_password, is_temp_credential, status)
    VALUES ('super_admin', 'Super Admin', ?, ?, 1, 1, 'active')
  `).run(tempUsername, passwordHash);

  const message = `
============================================================
 ONE-TIME SUPER ADMIN LOGIN CREDENTIAL (E-Codex Play)
============================================================
 Username: ${tempUsername}
 Password: ${tempPassword}

 - Use this to log in at /signin (role: Super Admin).
 - On first login, you will immediately be asked to create a permanent
   username and password. Once done, the temporary
   credential will DISAPPEAR and never work again.
 - Delete this file once you have retrieved the credentials.
============================================================
`;

  console.log(message);
  fs.writeFileSync(CREDENTIAL_FILE, message, { encoding: 'utf8', mode: 0o600 });
}

module.exports = bootstrapSuperAdmin;
