const express = require('express');
const db = require('../db');

const router = express.Router();

// PUBLIC endpoint — no login required, since even the sign-in page and a
// logged-out visitor need to know whether the site is in maintenance mode.
router.get('/', (req, res) => {
  const row = db.prepare('SELECT status, message, updated_at FROM system_status WHERE id = 1').get();
  res.json(row || { status: 'online', message: null });
});

module.exports = router;
