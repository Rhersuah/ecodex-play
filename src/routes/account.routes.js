const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const { verifyPassword, hashPassword } = require('../auth');
const { makeUploader } = require('../utils/upload');

const router = express.Router();
const avatarUpload = makeUploader('avatars', { perUser: true });

router.get('/', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Update editable profile fields. Username/name changes are allowed here for
// any role, but role and id_number are never editable through this endpoint.
router.put('/', requireAuth, (req, res) => {
  const { fullName, username, mobile } = req.body;
  if (username) {
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (conflict) return res.status(409).json({ error: 'This username is already taken.' });
  }
  db.prepare(`
    UPDATE users SET
      full_name = COALESCE(?, full_name),
      username = COALESCE(?, username),
      mobile = COALESCE(?, mobile),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(fullName || null, username || null, mobile || null, req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  delete user.password_hash;
  res.json({ user });
});

router.post('/avatar', requireAuth, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo was uploaded.' });
  const url = `/uploads/avatars/${req.file.filename}`;
  // Only regular users go through approval — an Admin or Super Admin's own
  // photo change applies instantly since they're staff, not a raffle player.
  if (req.user.role === 'admin' || req.user.role === 'super_admin') {
    db.prepare("UPDATE users SET avatar_url = ?, pending_avatar_url = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(url, req.user.id);
    return res.json({ avatar_url: url, pending: false });
  }
  db.prepare("UPDATE users SET pending_avatar_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(url, req.user.id);
  res.json({ pending_avatar_url: url, pending: true, message: 'New photo submitted. Awaiting approval from Admin/Super Admin.' });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(currentPassword || '', full.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  }
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  db.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
