// Run with:  npm run reset-superadmin
// Must be run directly on the host machine (terminal access to the server).
// This deletes the current super_admin account(s) and lets the normal
// bootstrap process generate a fresh one-time credential the next time
// the server starts.
const readline = require('readline');
const db = require('../db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question(
  'Are you sure you want to reset the Super Admin account? This will permanently remove\n' +
  'the current super admin account and you will need to bootstrap again. (yes/no): ',
  (answer) => {
    if (answer.trim().toLowerCase() === 'yes') {
      const result = db.prepare("DELETE FROM users WHERE role = 'super_admin'").run();
      console.log(`Removed ${result.changes} super_admin account(s). Restart the server (npm start) to generate a new one-time credential.`);
    } else {
      console.log('Cancelled. Nothing changed.');
    }
    rl.close();
    process.exit(0);
  }
);
