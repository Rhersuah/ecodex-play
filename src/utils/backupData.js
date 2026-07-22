// src/utils/backupData.js
//
// Run this with: npm run backup
//
// Copies your database (all users, tickets, balances, transactions — every
// bit of real data), uploaded files (photos, QR codes, proof of payment),
// and your .env file to a folder called `ecodex-backups`, placed OUTSIDE
// the backend folder (one level up, in E:\E-codex-Play\ecodex-backups\ if
// your backend is in E:\E-codex-Play\backend). This means even if you later
// delete the whole backend folder to replace it with a new version, your
// backup survives.
//
// ALWAYS run this BEFORE deleting/replacing your backend folder for an
// update. Then after extracting the new version, run the restore steps
// printed at the end of this script — in order, BEFORE the very first
// "npm start" of the new backend. Restoring the database before that first
// start is what stops a brand new Super Admin account from being generated
// on top of your real one.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..');
const DB_PATH = path.join(DATA_DIR, 'data', 'ecodex.sqlite');
const UPLOADS_PATH = path.join(DATA_DIR, 'uploads');
const ENV_PATH = path.join(DATA_DIR, '.env');

const BACKUP_ROOT = path.join(DATA_DIR, '..', 'ecodex-backups');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const thisBackupDir = path.join(BACKUP_ROOT, timestamp);

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
  return true;
}

console.log('E-Codex Play — Backing up your data...\n');

fs.mkdirSync(thisBackupDir, { recursive: true });

const dbCopied = copyRecursive(DB_PATH, path.join(thisBackupDir, 'ecodex.sqlite'));
console.log(dbCopied ? `✓ Database backed up (users, tickets, balances, transactions)` : `✗ No database found at ${DB_PATH} — nothing to back up yet.`);
if (dbCopied) {
  const sizeKb = (fs.statSync(DB_PATH).size / 1024).toFixed(1);
  console.log(`  (${sizeKb} KB — write this number down so you can double-check the restore later)`);
}

const uploadsCopied = copyRecursive(UPLOADS_PATH, path.join(thisBackupDir, 'uploads'));
console.log(uploadsCopied ? `✓ Uploaded files backed up (photos, QR codes, proof of payment)` : `  (no uploads folder found — that's fine if you haven't had any uploads yet)`);

const envCopied = copyRecursive(ENV_PATH, path.join(thisBackupDir, '.env'));
console.log(envCopied ? `✓ .env backed up (same JWT_SECRET means users won't get logged out after the update)` : `  (no .env found — that's unusual, make sure you set one up)`);

console.log(`\nBackup saved to:\n  ${thisBackupDir}\n`);
console.log('IMPORTANT: this backup folder is OUTSIDE your backend folder, so it is');
console.log('safe even if you delete the whole backend folder for an update.\n');
console.log('To restore into a NEW backend version (do this BEFORE the first "npm start"):');
console.log('  1. Extract the new zip and run "npm install" — do NOT run "npm start" yet');
console.log('  2. Create a "data" folder inside the new backend if it does not exist yet');
console.log(`  3. Copy "${path.join(thisBackupDir, 'ecodex.sqlite')}"`);
console.log('     into the new backend\'s "data" folder');
console.log(`  4. Copy "${path.join(thisBackupDir, '.env')}" into the new backend folder root`);
console.log('     (same folder as server.js) — replace the .env.example-based one if you made one');
console.log(`  5. If you had uploads, also copy the "${path.join(thisBackupDir, 'uploads')}" folder`);
console.log('     directly into the new backend folder root (so it sits at backend\\uploads)');
console.log('  6. NOW run "npm start" for the first time — your Super Admin, Admins, users,');
console.log('     tickets, and balances will all be there already, and nobody gets logged out.');
