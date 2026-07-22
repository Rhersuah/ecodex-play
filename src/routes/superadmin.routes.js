const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { hashPassword } = require('../auth');
const crypto = require('crypto');
const { awardPoints, getPointsRates } = require('../pointsHelper');
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT } = require('../utils/upload');

const router = express.Router();
router.use(requireAuth, requireRole('super_admin'));

function publicUser(u) { const { password_hash, ...rest } = u; return rest; }
function logAction(req, action, target, details) {
  db.prepare('INSERT INTO audit_log (actor_id, actor_role, action, target, details) VALUES (?,?,?,?,?)')
    .run(req.user.id, req.user.role, action, target || null, details ? JSON.stringify(details) : null);
}

// ---------------- Dashboard ----------------
router.get('/dashboard', (req, res) => {
  const totalAdmins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  const realTotalUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE role='user' AND approval_status != 'rejected'").get().c;
  const bannedUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE status='banned'").get().c;
  const pendingDeposits = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE status IN ('pending','admin_approved')").get().c;
  const pendingWithdrawals = db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE status IN ('pending','admin_approved')").get().c;
  const approvedDeposits = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE status='approved'").get().c;
  const approvedWithdrawals = db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE status='approved'").get().c;
  const realTotalTickets = db.prepare("SELECT COUNT(*) c FROM tickets").get().c;
  const realWinners = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='won'").get().c;
  const totalPlatformBalance = db.prepare("SELECT COALESCE(SUM(balance),0) s FROM users WHERE role='user'").get().s;
  const overrides = db.prepare('SELECT * FROM dashboard_overrides WHERE id = 1').get();

  res.json({
    totalAdmins,
    totalUsers: overrides.members_override ?? realTotalUsers,
    bannedUsers,
    pendingTransactions: pendingDeposits + pendingWithdrawals,
    completedTransactions: approvedDeposits + approvedWithdrawals,
    totalTickets: overrides.issued_tickets_override ?? realTotalTickets,
    totalWinners: overrides.winners_override ?? realWinners,
    totalPlatformBalance,
  });
});

// ---------------- Admin Management (create/list/ban admins) ----------------
router.get('/admins', (req, res) => {
  const admins = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY created_at DESC").all();
  res.json({ admins: admins.map(publicUser) });
});

router.post('/admins', (req, res) => {
  const { fullName, username, email, mobile, password } = req.body;
  if (!fullName || !username || !password) {
    return res.status(400).json({ error: 'Please complete the name, username, and password.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'This username is already taken.' });

  const info = db.prepare(`
    INSERT INTO users (role, full_name, username, email, mobile, password_hash, status, created_by, must_change_password, is_temp_credential)
    VALUES ('admin', ?, ?, ?, ?, ?, 'active', ?, 1, 1)
  `).run(fullName, username, email || null, mobile || null, hashPassword(password), req.user.id);

  logAction(req, 'create_admin', `user:${info.lastInsertRowid}`);
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ admin: publicUser(admin) });
});

router.patch('/admins/:id/status', (req, res) => {
  const { status, reason } = req.body;
  if (!['active', 'banned'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const admin = db.prepare("SELECT * FROM users WHERE id = ? AND role='admin'").get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found.' });
  db.prepare("UPDATE users SET status = ?, ban_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(status, status === 'banned' ? (reason || null) : null, admin.id);
  logAction(req, 'set_admin_status', `user:${admin.id}`, { status });
  res.json({ ok: true });
});

router.delete('/admins/:id', (req, res) => {
  const admin = db.prepare("SELECT * FROM users WHERE id = ? AND role='admin'").get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
  logAction(req, 'delete_admin', `user:${admin.id}`);
  res.json({ ok: true });
});

// ---------------- User Management (super admin has full power) ----------------
router.get('/users', (req, res) => {
  const users = db.prepare("SELECT * FROM users WHERE role='user' ORDER BY created_at DESC").all();
  res.json({ users: users.map(publicUser) });
});

router.patch('/users/:id/status', (req, res) => {
  const { status, reason } = req.body;
  if (!['active', 'banned'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role='user'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  db.prepare("UPDATE users SET status = ?, ban_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(status, status === 'banned' ? (reason || null) : null, user.id);
  logAction(req, 'set_user_status', `user:${user.id}`, { status });
  res.json({ ok: true });
});

router.patch('/users/:id/balance', (req, res) => {
  const { amount, mode, note } = req.body; // mode: 'add' | 'subtract' | 'set'
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role='user'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const amt = Number(amount);
  if (Number.isNaN(amt) || amt < 0) return res.status(400).json({ error: 'Invalid amount.' });

  let newBalance = user.balance;
  if (mode === 'add') newBalance += amt;
  else if (mode === 'subtract') newBalance = Math.max(0, newBalance - amt);
  else if (mode === 'set') newBalance = amt;
  else return res.status(400).json({ error: "mode must be 'add', 'subtract', or 'set'." });

  db.prepare("UPDATE users SET balance = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(newBalance, user.id);
  logAction(req, 'adjust_balance', `user:${user.id}`, { mode, amt, note });
  res.json({ ok: true, balance: newBalance });
});

// NOTE: deposit destination management (where users send their money) is
// shared between admin + super_admin and lives in shared.routes.js under
// /api/shared/deposit-destinations so both roles hit the same code path.

// ---------------- Level 2 Final Transaction Approval + Emergency Bypass ----------------
function attachUserInfo(items) {
  return items.map((item) => {
    const user = db.prepare('SELECT id, full_name, mobile FROM users WHERE id = ?').get(item.user_id);
    return { ...item, user };
  });
}

router.get('/transactions/queue', (req, res) => {
  const deposits = db.prepare("SELECT *, 'deposit' as txType FROM deposit_requests WHERE status IN ('admin_approved','pending') ORDER BY created_at DESC").all();
  const withdrawals = db.prepare("SELECT *, 'withdrawal' as txType FROM withdrawal_requests WHERE status IN ('admin_approved','pending') ORDER BY created_at DESC").all();
  res.json({
    readyForFinalRelease: attachUserInfo([...deposits, ...withdrawals].filter(i => i.status === 'admin_approved')),
    stuckAtLevel1: attachUserInfo([...deposits, ...withdrawals].filter(i => i.status === 'pending')),
  });
});

router.post('/transactions/:type(deposit|withdrawal)/:id/finalize', (req, res) => {
  const { type, id } = req.params;
  const { decision, reason } = req.body; // decision: 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });

  const table = type === 'deposit' ? 'deposit_requests' : 'withdrawal_requests';
  const record = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!record) return res.status(404).json({ error: 'Transaction not found.' });
  if (!['admin_approved', 'pending'].includes(record.status)) {
    return res.status(409).json({ error: 'This transaction has already been processed.' });
  }
  if (type === 'withdrawal' && decision === 'approved' && !record.otp_verified) {
    return res.status(409).json({ error: 'This withdrawal cannot be approved yet — the user must verify their OTP code first. Generate one from OTP Management.' });
  }

  db.runInTransaction(() => {
    db.prepare(`UPDATE ${table} SET status=?, reviewed_by_super_admin=?, reject_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(decision, req.user.id, decision === 'rejected' ? (reason || null) : null, id);

    if (decision === 'approved' && type === 'deposit') {
      const creditAmount = record.net_amount != null ? record.net_amount : record.amount;
      db.prepare("UPDATE users SET balance = balance + ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(creditAmount, record.user_id);

      // Deposits earn Points too, just at a lower rate than actually
      // playing — rewards engagement over simply parking money here.
      awardPoints(db, record.user_id, 'deposit', creditAmount);
    }
    if (decision === 'rejected' && type === 'withdrawal') {
      // Funds were held at request time — refund back to the user.
      db.prepare("UPDATE users SET balance = balance + ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(record.amount, record.user_id);
    }
  });

  logAction(req, `finalize_${type}`, `${type}:${id}`, { decision });
  res.json({ ok: true });
});

// ---------------- System-Wide Status (Shutdown / Maintenance / Updating) ----------------
router.get('/system-status', (req, res) => {
  const row = db.prepare('SELECT status, message, updated_at FROM system_status WHERE id = 1').get();
  res.json(row);
});

router.patch('/system-status', (req, res) => {
  const { status, message } = req.body;
  const allowed = ['online', 'maintenance', 'updating', 'shutdown'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be one of: ' + allowed.join(', ') });
  }
  db.prepare("UPDATE system_status SET status=?, message=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1")
    .run(status, message || null, req.user.id);
  logAction(req, 'set_system_status', 'system', { status, message });
  res.json({ ok: true, status, message: message || null });
});

// ---------------- Dashboard Manual Overrides (Issued Tickets / Winners / Members) ----------------
router.get('/dashboard-overrides', (req, res) => {
  res.json(db.prepare('SELECT * FROM dashboard_overrides WHERE id = 1').get());
});

router.patch('/dashboard-overrides', (req, res) => {
  const { issuedTickets, winners, members } = req.body;
  const current = db.prepare('SELECT * FROM dashboard_overrides WHERE id = 1').get();
  db.prepare(`
    UPDATE dashboard_overrides SET
      issued_tickets_override = ?, winners_override = ?, members_override = ?,
      updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `).run(
    issuedTickets !== undefined ? issuedTickets : current.issued_tickets_override,
    winners !== undefined ? winners : current.winners_override,
    members !== undefined ? members : current.members_override,
    req.user.id
  );
  logAction(req, 'set_dashboard_overrides', 'dashboard', { issuedTickets, winners, members });
  res.json(db.prepare('SELECT * FROM dashboard_overrides WHERE id = 1').get());
});

// ---------------- Pre-Generated Ticket Inventory Approval (ECP-####) ----------------
router.get('/tickets/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT ti.*, u.full_name as created_by_name
    FROM ticket_inventory ti LEFT JOIN users u ON u.id = ti.created_by
    WHERE ti.status = 'pending_approval'
    ORDER BY ti.created_at DESC
  `).all();
  res.json({ tickets: rows });
});

router.get('/tickets', (req, res) => {
  const rows = db.prepare(`
    SELECT ti.*, u.full_name as owner_name
    FROM ticket_inventory ti LEFT JOIN users u ON u.id = ti.owner_user_id
    ORDER BY ti.created_at DESC LIMIT 500
  `).all();
  res.json({ tickets: rows });
});

router.post('/tickets/:id/approve', (req, res) => {
  const ticket = db.prepare('SELECT * FROM ticket_inventory WHERE id = ?').get(req.params.id);
  if (!ticket || ticket.status !== 'pending_approval') return res.status(404).json({ error: 'No pending ticket found.' });
  db.prepare("UPDATE ticket_inventory SET status='approved', approved_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(req.user.id, ticket.id);
  logAction(req, 'approve_ticket', `ticket:${ticket.id}`);
  res.json({ ok: true });
});

router.post('/tickets/:id/reject', (req, res) => {
  const ticket = db.prepare('SELECT * FROM ticket_inventory WHERE id = ?').get(req.params.id);
  if (!ticket || ticket.status !== 'pending_approval') return res.status(404).json({ error: 'No pending ticket found.' });
  db.prepare("UPDATE ticket_inventory SET status='rejected', approved_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(req.user.id, ticket.id);
  logAction(req, 'reject_ticket', `ticket:${ticket.id}`);
  res.json({ ok: true });
});

router.post('/tickets/:id/deploy', (req, res) => {
  const ticket = db.prepare('SELECT * FROM ticket_inventory WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (ticket.status !== 'approved') return res.status(409).json({ error: 'Only approved tickets can be deployed.' });
  const { destination, auctionDurationHours } = req.body;
  const allowed = ['buy_tickets', 'shop', 'auction'];
  const dest = allowed.includes(destination) ? destination : 'buy_tickets';

  db.runInTransaction(() => {
    db.prepare("UPDATE ticket_inventory SET status='deployed', deploy_destination=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(dest, ticket.id);
    if (dest === 'auction') {
      const hours = Math.max(1, Number(auctionDurationHours) || 24);
      const endTime = new Date(Date.now() + hours * 3600000).toISOString();
      db.prepare(`
        INSERT INTO auction_items (name, description, starting_price, current_price, min_increment, end_time, created_by)
        VALUES (?,?,?,?,?,?,?)
      `).run(`${ticket.tier.charAt(0).toUpperCase() + ticket.tier.slice(1)} Ticket — ${ticket.ticket_code}`, `A ${ticket.tier} tier raffle ticket up for auction.`, ticket.price, ticket.price, Math.max(1, Math.round(ticket.price * 0.1)), endTime, req.user.id);
    }
  });

  res.json({ ok: true });
});

// ---------------- OTP Management (6-digit, tied to withdrawal verification) ----------------
router.get('/otp/pending-withdrawals', (req, res) => {
  const rows = db.prepare(`
    SELECT wr.*, u.full_name, u.username
    FROM withdrawal_requests wr JOIN users u ON u.id = wr.user_id
    WHERE wr.status IN ('pending','admin_approved') AND wr.otp_verified = 0
    ORDER BY wr.created_at DESC
  `).all();
  res.json({ withdrawals: rows });
});

router.post('/otp/generate', (req, res) => {
  const { userId, relatedType, relatedId } = req.body;
  if (!userId || !relatedType || !relatedId) {
    return res.status(400).json({ error: 'userId, relatedType, and relatedId are required.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.runInTransaction(() => {
    db.prepare(`
      INSERT INTO otp_codes (user_id, code, purpose, related_type, related_id, expires_at, created_by)
      VALUES (?, ?, 'transaction_verification', ?, ?, ?, ?)
    `).run(userId, code, relatedType, String(relatedId), expiresAt, req.user.id);

    db.prepare('INSERT INTO messages (thread_user_id, sender_id, sender_role, body) VALUES (?,?,?,?)')
      .run(userId, req.user.id, req.user.role,
        `Your verification code for your ${relatedType} request is: ${code}. This code expires in 15 minutes. Please enter it to confirm your transaction.`);
  });

  logAction(req, 'generate_otp', `${relatedType}:${relatedId}`, { userId });
  res.status(201).json({ ok: true, code });
});

// ---------------- Ban Requests Approval (2nd approver) ----------------
router.get('/ban-requests/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT br.*, u.full_name as user_name, u.username as user_username, a.full_name as requested_by_name
    FROM ban_requests br
    JOIN users u ON u.id = br.user_id
    JOIN users a ON a.id = br.requested_by
    WHERE br.status = 'pending'
    ORDER BY br.created_at DESC
  `).all();
  res.json({ requests: rows });
});

router.post('/ban-requests/:id/approve', (req, res) => {
  const request = db.prepare("SELECT * FROM ban_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!request) return res.status(404).json({ error: 'No pending ban request found.' });

  let banExpiresAt = null;
  if (request.ban_type === 'temporary' && request.ban_ends_at) {
    banExpiresAt = request.ban_ends_at;
  }

  db.runInTransaction(() => {
    db.prepare("UPDATE users SET status='banned', ban_reason=?, ban_expires_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(request.reason || (request.event_name ? `Banned for event: ${request.event_name}` : 'Banned'), banExpiresAt, request.user_id);
    db.prepare("UPDATE ban_requests SET status='approved', reviewed_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
      .run(req.user.id, request.id);
  });

  logAction(req, 'approve_ban_request', `user:${request.user_id}`, { banType: request.ban_type });
  res.json({ ok: true });
});

router.post('/ban-requests/:id/reject', (req, res) => {
  const request = db.prepare("SELECT * FROM ban_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!request) return res.status(404).json({ error: 'No pending ban request found.' });
  db.prepare("UPDATE ban_requests SET status='rejected', reviewed_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    .run(req.user.id, request.id);
  res.json({ ok: true });
});

// ---------------- Winner Approval (Level 2 - Final) ----------------
router.get('/winners/pending', (req, res) => {
  const raffleWinners = db.prepare(`
    SELECT t.id, t.ticket_number, t.rank, u.full_name, u.username, u.mobile, u.email, d.name as draw_name, 'raffle' as source
    FROM tickets t
    JOIN users u ON u.id = t.user_id
    JOIN draws d ON d.id = t.draw_id
    WHERE t.status = 'won' AND t.winner_status = 'admin_verified'
  `).all();
  const poolWinners = db.prepare(`
    SELECT ti.id, ti.ticket_code as ticket_number, ti.pool_rank as rank, u.full_name, u.username, u.mobile, u.email, d.name as draw_name, 'pool' as source
    FROM ticket_inventory ti
    JOIN users u ON u.id = ti.owner_user_id
    JOIN draws d ON d.id = ti.dropped_into_draw_id
    WHERE ti.pool_result = 'won' AND ti.pool_winner_status = 'admin_verified'
  `).all();
  const all = [...raffleWinners, ...poolWinners].sort((a, b) => a.rank - b.rank);
  res.json({ winners: all });
});

// Approving a winner is where the actual prize amount is entered and
// credited straight to the winner's balance — the one place real money
// changes hands for a draw win.
router.post('/winners/:source/:id/approve', (req, res) => {
  const { source, id } = req.params;
  const amount = parseFloat(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'A valid prize amount is required.' });

  let ownerUserId;
  try {
    db.runInTransaction(() => {
      if (source === 'pool') {
        const ticket = db.prepare("SELECT * FROM ticket_inventory WHERE id = ? AND pool_result='won' AND pool_winner_status='admin_verified'").get(id);
        if (!ticket) throw new Error('No verified winner found awaiting final approval.');
        db.prepare("UPDATE ticket_inventory SET pool_winner_status='approved', pool_winner_amount=? WHERE id=?").run(amount, ticket.id);
        ownerUserId = ticket.owner_user_id;
      } else {
        const ticket = db.prepare("SELECT * FROM tickets WHERE id = ? AND status='won' AND winner_status='admin_verified'").get(id);
        if (!ticket) throw new Error('No verified winner found awaiting final approval.');
        db.prepare("UPDATE tickets SET winner_status='approved' WHERE id=?").run(ticket.id);
        ownerUserId = ticket.user_id;
      }
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, ownerUserId);
    });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }

  logAction(req, 'approve_winner', `${source}:${id}`, { amount });
  res.json({ ok: true });
});

// ---------------- Activity Log (visibility into every Admin's actions) ----------------
router.get('/activity-log', (req, res) => {
  const rows = db.prepare(`
    SELECT al.*, u.full_name as actor_name
    FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
    ORDER BY al.created_at DESC LIMIT 200
  `).all();
  res.json({ log: rows });
});

// ------------------------------------------------------------------
// PASSWORD RESET (not reveal) — passwords are one-way hashed and can
// never be read back, even by Super Admin; that's the whole point of
// hashing. If someone forgets their password, the correct fix is to
// issue a new temporary one (same mechanism as the original one-time
// credential) that forces them to set their own permanent password on
// next login. This achieves account recovery without ever storing or
// displaying a real, usable plaintext password anywhere.
// ------------------------------------------------------------------
router.post('/users/:id/reset-password', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role='user'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const tempPassword = crypto.randomBytes(6).toString('hex');
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 1, is_temp_credential = 1, password_reset_only = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(hashPassword(tempPassword), user.id);

  logAction(req, 'reset_user_password', `user:${user.id}`);
  res.json({ ok: true, tempPassword, message: 'Give this temporary password to the user. They will only be asked to set a new password on next login.' });
});

router.post('/admins/:id/reset-password', (req, res) => {
  const admin = db.prepare("SELECT * FROM users WHERE id = ? AND role='admin'").get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found.' });

  const tempPassword = crypto.randomBytes(6).toString('hex');
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 1, is_temp_credential = 1, password_reset_only = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(hashPassword(tempPassword), admin.id);

  logAction(req, 'reset_admin_password', `user:${admin.id}`);
  res.json({ ok: true, tempPassword, message: 'Give this temporary password to the admin. They will only be asked to set a new password on next login.' });
});

// ---------------- Predetermined Winner Approvals (only when Admin set one) ----------------
router.get('/draws/pending-predetermined', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.full_name as set_by_name
    FROM draws d JOIN users u ON u.id = d.predetermined_by
    WHERE d.predetermined_winner IS NOT NULL AND d.predetermined_approved = 0 AND d.status = 'open'
  `).all();
  res.json({ pending: rows });
});

router.post('/draws/:id/approve-predetermined', (req, res) => {
  const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
  if (!draw || !draw.predetermined_winner) return res.status(404).json({ error: 'No predetermined winner to approve.' });
  db.prepare('UPDATE draws SET predetermined_approved = 1 WHERE id = ?').run(draw.id);
  res.json({ ok: true });
});

router.post('/draws/:id/reject-predetermined', (req, res) => {
  const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
  if (!draw) return res.status(404).json({ error: 'Draw not found.' });
  db.prepare('UPDATE draws SET predetermined_winner = NULL, predetermined_by = NULL, predetermined_approved = 0 WHERE id = ?').run(draw.id);
  res.json({ ok: true });
});

// Super Admin can delete any draw outright — useful for cleaning up stray
// or leftover pool-draw entries that shouldn't be in the system anymore.
router.get('/draws', (req, res) => {
  res.json({ draws: db.prepare('SELECT * FROM draws ORDER BY created_at DESC').all() });
});

router.delete('/draws/:id', (req, res) => {
  const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
  if (!draw) return res.status(404).json({ error: 'Draw not found.' });
  const force = req.query.force === 'true' || req.body?.force === true;
  const deleteTickets = req.query.deleteTickets === 'true' || req.body?.deleteTickets === true;

  const soldTicketsInDraw = db.prepare("SELECT COUNT(*) c FROM tickets WHERE draw_id = ? AND status != 'cancelled'").get(draw.id).c;
  const droppedTicketsInDraw = db.prepare('SELECT COUNT(*) c FROM ticket_inventory WHERE dropped_into_draw_id = ?').get(draw.id).c;

  if ((soldTicketsInDraw > 0 || droppedTicketsInDraw > 0) && !force) {
    return res.status(409).json({
      error: `This draw has ${soldTicketsInDraw + droppedTicketsInDraw} ticket(s) attached. Remove or reassign them first, or force delete.`,
      canForce: true,
    });
  }

  db.runInTransaction(() => {
    if (deleteTickets) {
      // Non-sold tickets can be safely destroyed. Sold tickets are never
      // destroyed (a real purchase), but they STILL must be unlinked from
      // this draw — otherwise the foreign key on dropped_into_draw_id
      // blocks deleting the draw even in force mode.
      db.prepare("DELETE FROM ticket_inventory WHERE dropped_into_draw_id = ? AND status != 'sold'").run(draw.id);
      db.prepare("UPDATE ticket_inventory SET dropped_into_draw_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE dropped_into_draw_id = ?").run(draw.id);
    } else {
      db.prepare("UPDATE ticket_inventory SET dropped_into_draw_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE dropped_into_draw_id = ?").run(draw.id);
    }
    // Old-style raffle tickets (tickets.draw_id is a required, non-null
    // foreign key) MUST be cleared before the draw row itself can be
    // deleted — a draw can never be removed while any ticket, cancelled or
    // not, still points to it.
    db.prepare('DELETE FROM tickets WHERE draw_id = ?').run(draw.id);
    db.prepare('DELETE FROM draw_winners WHERE draw_id = ?').run(draw.id);
    db.prepare('DELETE FROM draws WHERE id = ?').run(draw.id);
  });

  logAction ? logAction(req, 'force_delete_draw', `draw:${draw.id}`) : null;
  res.json({ ok: true, forced: force });
});

// Super Admin can delete a user account outright. Blocks if the user has
// financial history (deposits/withdrawals/orders) to avoid silently
// destroying money records — Super Admin should resolve those first.
router.delete('/users/:id', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const hasHistory = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE user_id = ?").get(user.id).c
    + db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE user_id = ?").get(user.id).c
    + db.prepare("SELECT COUNT(*) c FROM shop_orders WHERE user_id = ?").get(user.id).c;

  const force = req.query.force === 'true';
  if (hasHistory > 0 && !force) {
    return res.status(409).json({
      error: `This user has ${hasHistory} transaction/order record(s). Force delete anyway?`,
      canForce: true,
    });
  }

  db.runInTransaction(() => {
    db.prepare('UPDATE ticket_inventory SET owner_user_id = NULL WHERE owner_user_id = ?').run(user.id);
    db.prepare('DELETE FROM tickets WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM messages WHERE thread_user_id = ? OR sender_id = ?').run(user.id, user.id);
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM ban_requests WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM user_delete_requests WHERE target_user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });

  logAction(req, 'delete_user', `user:${user.id}`);
  res.json({ ok: true });
});

// Admin-submitted requests to delete a user — Super Admin has final say.
router.get('/delete-requests/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.full_name as target_name, u.username as target_username, req.full_name as requested_by_name
    FROM user_delete_requests r
    JOIN users u ON u.id = r.target_user_id
    JOIN users req ON req.id = r.requested_by
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC
  `).all();
  res.json({ requests: rows });
});

router.post('/delete-requests/:id/approve', (req, res) => {
  const request = db.prepare("SELECT * FROM user_delete_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });

  db.runInTransaction(() => {
    db.prepare('UPDATE ticket_inventory SET owner_user_id = NULL WHERE owner_user_id = ?').run(request.target_user_id);
    db.prepare('DELETE FROM tickets WHERE user_id = ?').run(request.target_user_id);
    db.prepare('DELETE FROM messages WHERE thread_user_id = ? OR sender_id = ?').run(request.target_user_id, request.target_user_id);
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(request.target_user_id);
    db.prepare('DELETE FROM ban_requests WHERE user_id = ?').run(request.target_user_id);
    db.prepare("UPDATE user_delete_requests SET status = 'approved', reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.user.id, request.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(request.target_user_id);
  });

  logAction(req, 'approve_delete_user_request', `user:${request.target_user_id}`);
  res.json({ ok: true });
});

router.post('/delete-requests/:id/reject', (req, res) => {
  const request = db.prepare("SELECT * FROM user_delete_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  db.prepare("UPDATE user_delete_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.user.id, request.id);
  res.json({ ok: true });
});

// Tier 2 of signup code release — only shows signups Admin already
// reviewed. Approving here is what finally makes the code visible to the
// user waiting on their verify-email screen.
router.get('/signup-verifications/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.full_name, u.username, u.email, u.mobile, u.email_verification_code, u.created_at, u.rejection_reason, a.full_name as released_by_name
    FROM users u JOIN users a ON a.id = u.code_admin_approved_by
    WHERE u.approval_status = 'pending_email' AND u.code_admin_approved_by IS NOT NULL AND u.code_super_admin_approved_by IS NULL
    ORDER BY u.created_at ASC
  `).all();
  res.json({ pending: rows });
});

router.post('/signup-verifications/:id/approve', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND approval_status = 'pending_email' AND code_admin_approved_by IS NOT NULL").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Signup not found or not yet released by Admin.' });
  db.prepare('UPDATE users SET code_super_admin_approved_by = ? WHERE id = ?').run(req.user.id, user.id);
  res.json({ ok: true, message: 'Code released to the user.' });
});

router.post('/signup-verifications/:id/reject', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND approval_status = 'pending_email'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Signup not found.' });
  db.prepare("UPDATE users SET approval_status = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(user.id);
  res.json({ ok: true, message: 'Signup rejected.' });
});

// ---------------- Shop Orders — Tier 2 (Super Admin final approval) ----------------
router.get('/shop-orders/pending', (req, res) => {
  const orders = db.prepare(`
    SELECT so.*, si.name as item_name, u.full_name as buyer_name, u.username as buyer_username
    FROM shop_orders so JOIN shop_items si ON si.id = so.item_id JOIN users u ON u.id = so.user_id
    WHERE so.status = 'pending_superadmin' ORDER BY so.created_at ASC
  `).all();
  res.json({ orders });
});

router.post('/shop-orders/:id/approve', (req, res) => {
  const order = db.prepare("SELECT * FROM shop_orders WHERE id = ? AND status = 'pending_superadmin'").get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found or already reviewed.' });
  db.prepare("UPDATE shop_orders SET status = 'to_ship', super_admin_approved_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.user.id, order.id);
  res.json({ ok: true, message: 'Approved — order is now being packaged (To Ship).' });
});

router.post('/shop-orders/:id/reject', (req, res) => {
  const order = db.prepare("SELECT * FROM shop_orders WHERE id = ? AND status = 'pending_superadmin'").get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found or already reviewed.' });
  db.runInTransaction(() => {
    const item = db.prepare('SELECT * FROM shop_items WHERE id = ?').get(order.item_id);
    if (item) db.prepare('UPDATE shop_items SET stock = stock + ? WHERE id = ?').run(order.quantity, item.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.total_price, order.user_id);
    db.prepare("UPDATE shop_orders SET status = 'rejected', super_admin_approved_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.user.id, order.id);
  });
  res.json({ ok: true, message: 'Order rejected — stock and balance refunded.' });
});

// ---------------- Platform Service Fee (Super Admin only) ----------------
router.get('/platform-fee', (req, res) => {
  const depositFee = db.prepare("SELECT value FROM platform_settings WHERE key = 'deposit_fee_percent'").get();
  const withdrawalFee = db.prepare("SELECT value FROM platform_settings WHERE key = 'withdrawal_fee_percent'").get();
  res.json({
    depositFeePercent: depositFee ? parseFloat(depositFee.value) : 0,
    withdrawalFeePercent: withdrawalFee ? parseFloat(withdrawalFee.value) : 0,
  });
});

router.post('/platform-fee', (req, res) => {
  const { depositFeePercent, withdrawalFeePercent } = req.body;
  const dFee = Math.max(0, Math.min(100, parseFloat(depositFeePercent) || 0));
  const wFee = Math.max(0, Math.min(100, parseFloat(withdrawalFeePercent) || 0));
  db.prepare(`
    INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('deposit_fee_percent', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(String(dFee), req.user.id);
  db.prepare(`
    INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('withdrawal_fee_percent', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(String(wFee), req.user.id);
  logAction(req, 'update_platform_fee', `deposit: ${dFee}%, withdrawal: ${wFee}%`);
  res.json({ ok: true });
});

// ---------------- Points Rate Configuration (Super Admin only) ----------------
router.get('/points-rates', (req, res) => {
  const rates = getPointsRates(db);
  res.json(rates);
});

router.post('/points-rates', (req, res) => {
  const { deposit, ticket, shop, auction } = req.body;
  const categories = { deposit, ticket, shop, auction };
  Object.entries(categories).forEach(([category, value]) => {
    if (value == null) return;
    const clean = Math.max(0, parseFloat(value) || 0);
    db.prepare(`
      INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(`points_rate_${category}`, String(clean), req.user.id);
  });
  logAction(req, 'update_points_rates', JSON.stringify(categories));
  res.json({ ok: true });
});

// ---------------- File Storage Management (Super Admin only) ----------------
// Every category of file the platform accepts uploads for. Shown to Super
// Admin as organized sections in Settings, each independently manageable.
const STORAGE_CATEGORIES = {
  'avatars': 'Profile Pictures',
  'shop': 'Shop Item Images',
  'ticket-qr': 'Ticket QR Codes',
  'audio': 'Background Music',
  'shard-events': 'Item Collection Event Photos',
  'signup-ids': 'ID Verification Photos',
  'deposit-qr': 'Payment QR Codes',
  'event-media': 'Announcement Media',
  'proofs': 'Deposit/Withdrawal Proofs',
};
// Categories organized as uploads/<category>/<userId>/<file> instead of a
// single flat folder — keeps the file system fast to browse even with
// thousands of users, and makes it obvious in File Storage Management
// whose file is whose.
const PER_USER_CATEGORIES = new Set(['avatars', 'proofs']);

router.get('/storage', (req, res) => {
  const retentionRows = db.prepare('SELECT * FROM storage_retention_settings').all();
  const retentionMap = {};
  retentionRows.forEach(r => { retentionMap[r.category] = r.retention_days; });

  const categories = Object.entries(STORAGE_CATEGORIES).map(([key, label]) => {
    const dir = path.join(UPLOADS_ROOT, key);
    let files = [];
    let userFolders = null;

    if (fs.existsSync(dir)) {
      if (PER_USER_CATEGORIES.has(key)) {
        // Walk each user's own subfolder and group their files together.
        userFolders = fs.readdirSync(dir)
          .filter(name => fs.statSync(path.join(dir, name)).isDirectory())
          .map((userIdStr) => {
            const userDir = path.join(dir, userIdStr);
            const userFiles = fs.readdirSync(userDir)
              .filter(name => fs.statSync(path.join(userDir, name)).isFile())
              .map((name) => {
                const stat = fs.statSync(path.join(userDir, name));
                return { name, url: `/uploads/${key}/${userIdStr}/${name}`, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
              })
              .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
            const owner = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(userIdStr);
            files.push(...userFiles.map(f => ({ ...f, userId: userIdStr })));
            return {
              userId: userIdStr,
              ownerName: owner ? owner.full_name : `User #${userIdStr} (deleted)`,
              ownerUsername: owner ? owner.username : null,
              fileCount: userFiles.length,
              files: userFiles,
            };
          })
          .filter(u => u.fileCount > 0)
          .sort((a, b) => b.fileCount - a.fileCount);
      } else {
        files = fs.readdirSync(dir)
          .filter(name => fs.statSync(path.join(dir, name)).isFile())
          .map(name => {
            const stat = fs.statSync(path.join(dir, name));
            return {
              name,
              url: `/uploads/${key}/${name}`,
              sizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            };
          })
          .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
      }
    }
    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    return {
      key, label, fileCount: files.length, totalBytes, files,
      isPerUser: PER_USER_CATEGORIES.has(key),
      userFolders,
      retentionDays: retentionMap[key] || null,
    };
  });

  res.json({ categories });
});

router.delete('/storage/:category/:filename', (req, res) => {
  const { category, filename } = req.params;
  if (!STORAGE_CATEGORIES[category]) return res.status(400).json({ error: 'Unknown storage category.' });
  // Guard against path traversal — filename must not escape its folder.
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename.' });
  }
  const filePath = path.join(UPLOADS_ROOT, category, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
  fs.unlinkSync(filePath);
  logAction(req, 'delete_storage_file', `${category}/${filename}`);
  res.json({ ok: true });
});

router.delete('/storage/:category/user/:userId/:filename', (req, res) => {
  const { category, userId, filename } = req.params;
  if (!STORAGE_CATEGORIES[category] || !PER_USER_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Unknown per-user storage category.' });
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')
    || String(userId).includes('..') || String(userId).includes('/')) {
    return res.status(400).json({ error: 'Invalid path.' });
  }
  const filePath = path.join(UPLOADS_ROOT, category, String(userId), filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
  fs.unlinkSync(filePath);
  logAction(req, 'delete_storage_file', `${category}/${userId}/${filename}`);
  res.json({ ok: true });
});

router.post('/storage/:category/bulk-delete', (req, res) => {
  const { category } = req.params;
  const { filenames } = req.body;
  if (!STORAGE_CATEGORIES[category]) return res.status(400).json({ error: 'Unknown storage category.' });
  if (!Array.isArray(filenames)) return res.status(400).json({ error: 'filenames must be an array.' });

  let deleted = 0;
  for (const filename of filenames) {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) continue;
    const filePath = path.join(UPLOADS_ROOT, category, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deleted++;
    }
  }
  logAction(req, 'bulk_delete_storage_files', `${category} (${deleted} files)`);
  res.json({ ok: true, deleted });
});

router.post('/storage/:category/retention', (req, res) => {
  const { category } = req.params;
  const { retentionDays } = req.body;
  if (!STORAGE_CATEGORIES[category]) return res.status(400).json({ error: 'Unknown storage category.' });
  const days = retentionDays ? Math.max(1, parseInt(retentionDays, 10)) : null;
  db.prepare(`
    INSERT INTO storage_retention_settings (category, retention_days, updated_by, updated_at) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(category) DO UPDATE SET retention_days = excluded.retention_days, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(category, days, req.user.id);
  logAction(req, 'set_storage_retention', `${category} -> ${days ? days + ' days' : 'keep forever'}`);
  res.json({ ok: true });
});

// Deletes any file older than its category's configured retention period.
// Called on server startup and once every 24 hours — nothing needs to run
// externally for this to work.
function runStorageRetentionCleanup() {
  const rows = db.prepare('SELECT * FROM storage_retention_settings WHERE retention_days IS NOT NULL').all();
  const now = Date.now();
  let totalDeleted = 0;
  for (const row of rows) {
    const dir = path.join(UPLOADS_ROOT, row.category);
    if (!fs.existsSync(dir)) continue;
    const cutoffMs = row.retention_days * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (now - stat.mtime.getTime() > cutoffMs) {
        fs.unlinkSync(filePath);
        totalDeleted++;
      }
    }
  }
  if (totalDeleted > 0) {
    console.log(`[storage cleanup] Removed ${totalDeleted} file(s) past their retention period.`);
  }
}

router.get('/rejected-accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT id, full_name, username, email, mobile, address, id_photo, rejection_reason, created_at, updated_at
    FROM users WHERE role = 'user' AND approval_status = 'rejected'
    ORDER BY updated_at DESC
  `).all();
  res.json({ accounts: rows });
});

router.delete('/rejected-accounts/:id', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND approval_status = 'rejected'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Rejected account not found.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  logAction(req, 'delete_rejected_account', `user:${user.id}`);
  res.json({ ok: true });
});

module.exports = router;
module.exports.runStorageRetentionCleanup = runStorageRetentionCleanup;
