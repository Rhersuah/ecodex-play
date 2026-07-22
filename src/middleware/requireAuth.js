const { verifyToken } = require('../auth');
const db = require('../db');

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

// Verifies the session token (sent via Authorization header, NOT a cookie).
// Using a header instead of a cookie means each browser TAB keeps its own
// independent login session (stored in that tab's sessionStorage) — logging
// in as a different role in one tab no longer affects other open tabs.
function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'You are not logged in. Please log in first.' });

  const payload = verifyToken(token);
  if (!payload || payload.scope === 'complete-setup') {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user) return res.status(401).json({ error: 'Account not found.' });

  // Auto-lift temporary/event bans once their expiry has passed.
  if (user.status === 'banned' && user.ban_expires_at && new Date(user.ban_expires_at) <= new Date()) {
    db.prepare("UPDATE users SET status='active', ban_reason=NULL, ban_expires_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(user.id);
    user.status = 'active';
  }
  if (user.status === 'banned') {
    return res.status(403).json({ error: 'This account is banned.' });
  }
  if (user.must_change_password) {
    return res.status(428).json({ error: 'You must complete account setup first.', code: 'MUST_CHANGE_PASSWORD' });
  }

  delete user.password_hash;
  req.user = user;

  // Track staff "online" presence (throttled to ~once per 30s per user so
  // this doesn't add a write to every single API call).
  if (user.role === 'admin' || user.role === 'super_admin') {
    const staleness = user.last_seen_at ? Date.now() - new Date(user.last_seen_at).getTime() : Infinity;
    if (staleness > 30000) {
      db.prepare("UPDATE users SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(user.id);
    }
  }

  next();
}

// Only allows a short-lived "complete-setup" token through, for the one
// endpoint that lets a temp/forced account set its real credentials.
function requireSetupToken(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: 'Missing setup session.' });
  const payload = verifyToken(token);
  if (!payload || payload.scope !== 'complete-setup') {
    return res.status(401).json({ error: 'Invalid or expired setup session.' });
  }
  req.setupUserId = payload.id;
  next();
}

module.exports = { requireAuth, requireSetupToken };
