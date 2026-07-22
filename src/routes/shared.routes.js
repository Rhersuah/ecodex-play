const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { makeUploader, makeMediaUploader } = require('../utils/upload');
const liveEvents = require('../liveEvents');

const router = express.Router();
const qrUpload = makeUploader('deposit-qr');

// ------------------------------------------------------------------
// DEPOSIT DESTINATIONS
// Where users are told to send their money (GCash / Maya / Bank / etc).
// Managed by BOTH admin and super_admin, as requested. Read access is for
// any logged-in user (they need to see this before uploading proof of payment).
// ------------------------------------------------------------------
router.get('/deposit-destinations', requireAuth, (req, res) => {
  const isStaff = req.user.role === 'admin' || req.user.role === 'super_admin';
  const rows = isStaff
    ? db.prepare('SELECT * FROM deposit_destinations ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM deposit_destinations WHERE is_active = 1 ORDER BY id DESC').all();
  res.json({ destinations: rows });
});

router.post('/deposit-destinations', requireAuth, requireRole('admin', 'super_admin'), qrUpload.single('qrImage'), (req, res) => {
  const { gatewayName, accountName, accountNumber, instructions } = req.body;
  if (!gatewayName || !accountName || !accountNumber) {
    return res.status(400).json({ error: 'Please complete the gateway, account name, and account number.' });
  }
  const qrPath = req.file ? `/uploads/deposit-qr/${req.file.filename}` : null;
  const info = db.prepare(`
    INSERT INTO deposit_destinations (gateway_name, account_name, account_number, qr_image, instructions, updated_by)
    VALUES (?,?,?,?,?,?)
  `).run(gatewayName, accountName, accountNumber, qrPath, instructions || null, req.user.id);
  res.status(201).json({ destination: db.prepare('SELECT * FROM deposit_destinations WHERE id=?').get(info.lastInsertRowid) });
});

router.patch('/deposit-destinations/:id', requireAuth, requireRole('admin', 'super_admin'), qrUpload.single('qrImage'), (req, res) => {
  const dest = db.prepare('SELECT * FROM deposit_destinations WHERE id = ?').get(req.params.id);
  if (!dest) return res.status(404).json({ error: 'Not found.' });
  const { gatewayName, accountName, accountNumber, instructions, isActive } = req.body;
  const qrPath = req.file ? `/uploads/deposit-qr/${req.file.filename}` : dest.qr_image;
  db.prepare(`
    UPDATE deposit_destinations SET gateway_name=?, account_name=?, account_number=?, qr_image=?,
      instructions=?, is_active=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
  `).run(
    gatewayName || dest.gateway_name, accountName || dest.account_name, accountNumber || dest.account_number,
    qrPath, instructions !== undefined ? instructions : dest.instructions,
    isActive !== undefined ? (isActive ? 1 : 0) : dest.is_active, req.user.id, dest.id
  );
  res.json({ destination: db.prepare('SELECT * FROM deposit_destinations WHERE id=?').get(dest.id) });
});

router.delete('/deposit-destinations/:id', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  db.prepare('DELETE FROM deposit_destinations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// MESSAGES — one support thread per user. Staff replies are shown to the
// user with the sender's REAL identity hidden (shown as "Support Team")
// so that individual admins/super admins are never exposed to users.
// Staff members, when reading a thread, still see who on the team wrote
// each reply (for internal accountability) but never see it labeled
// with a fellow admin's personal account to the *user's* view.
// ------------------------------------------------------------------
function maskForUserView(rows) {
  return rows.map((m) => ({
    id: m.id,
    body: m.body,
    created_at: m.created_at,
    from: (m.sender_role === 'admin' || m.sender_role === 'super_admin') ? 'support' : 'me',
    displayName: (m.sender_role === 'admin' || m.sender_role === 'super_admin') ? 'System Administrator' : 'Ikaw',
  }));
}

// A user viewing their own thread.
router.get('/messages/my-thread', requireAuth, requireRole('user'), (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE thread_user_id = ? ORDER BY created_at ASC').all(req.user.id);
  res.json({ messages: maskForUserView(rows) });
});

router.post('/messages/my-thread', requireAuth, requireRole('user'), (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  db.prepare('INSERT INTO messages (thread_user_id, sender_id, sender_role, body) VALUES (?,?,?,?)')
    .run(req.user.id, req.user.id, 'user', body.trim());
  liveEvents.broadcast('messages', ['admin', 'super_admin']);
  res.status(201).json({ ok: true });
});

// Staff view: list all threads (grouped by user) and reply to a specific one.
router.get('/messages/threads', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  // One unified inbox: shows both User support threads AND staff-to-staff
  // threads together, sorted by most recent activity.
  //  - Super Admin sees every Admin as its own separate thread.
  //  - Admin sees a single shared "Super Admin" thread (thread_user_id =
  //    the Admin's own id — any Super Admin who replies lands in the same
  //    thread, same as how a User's single thread works).
  const userThreads = db.prepare(`
    SELECT u.id as user_id, u.full_name, u.username, u.role, u.avatar_url,
      (SELECT body FROM messages WHERE thread_user_id = u.id ORDER BY id DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages WHERE thread_user_id = u.id ORDER BY id DESC LIMIT 1) as last_at,
      (SELECT sender_id FROM messages WHERE thread_user_id = u.id ORDER BY id DESC LIMIT 1) as last_sender_id
    FROM users u WHERE u.role = 'user'
      AND EXISTS (SELECT 1 FROM messages WHERE thread_user_id = u.id)
  `).all();

  let staffThreads = [];
  if (req.user.role === 'super_admin') {
    staffThreads = db.prepare(`
      SELECT u.id as user_id, u.full_name, u.username, u.role, u.avatar_url,
        (SELECT body FROM messages WHERE thread_user_id = u.id ORDER BY id DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE thread_user_id = u.id ORDER BY id DESC LIMIT 1) as last_at,
        (SELECT sender_id FROM messages WHERE thread_user_id = u.id ORDER BY id DESC LIMIT 1) as last_sender_id
      FROM users u WHERE u.role = 'admin'
    `).all();
  } else {
    // Admin: a single synthetic thread representing "Super Admin" collectively.
    const last = db.prepare('SELECT body, created_at, sender_id FROM messages WHERE thread_user_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id);
    staffThreads = [{
      user_id: req.user.id, full_name: 'Super Admin', username: 'super_admin', role: 'super_admin', avatar_url: null,
      last_message: last ? last.body : null, last_at: last ? last.created_at : null, last_sender_id: last ? last.sender_id : null,
    }];
  }

  // Unread means: the last message wasn't sent by me, AND I haven't
  // actually opened this conversation since it arrived — tracked via
  // message_read_status, so it clears the moment staff views the thread,
  // not only once they reply.
  const readRows = db.prepare('SELECT thread_user_id, last_read_at FROM message_read_status WHERE staff_user_id = ?').all(req.user.id);
  const readMap = {};
  readRows.forEach(r => { readMap[r.thread_user_id] = r.last_read_at; });

  const allThreads = [...userThreads, ...staffThreads].map(t => {
    const notFromMe = !!(t.last_sender_id && t.last_sender_id !== req.user.id);
    const lastRead = readMap[t.user_id];
    const seenSinceLastMessage = lastRead && t.last_at && new Date(lastRead) >= new Date(t.last_at);
    return { ...t, unread: notFromMe && !seenSinceLastMessage };
  });

  const threads = allThreads.sort((a, b) => new Date(b.last_at || 0) - new Date(a.last_at || 0));
  res.json({ threads });
});

router.get('/messages/threads/:userId', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE thread_user_id = ? ORDER BY created_at ASC').all(req.params.userId);
  // Staff sees actual sender identity for internal accountability, and for
  // genuine staff-to-staff threads too (no masking between colleagues).
  const withNames = rows.map((m) => {
    const sender = db.prepare('SELECT full_name, role FROM users WHERE id = ?').get(m.sender_id);
    return { ...m, sender_name: sender ? sender.full_name : 'Unknown' };
  });

  // Viewing a conversation counts as reading it — clears the unread dot
  // for this staff member even if they don't reply right away.
  db.prepare(`
    INSERT INTO message_read_status (staff_user_id, thread_user_id, last_read_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(staff_user_id, thread_user_id) DO UPDATE SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(req.user.id, req.params.userId);

  res.json({ messages: withNames });
});

router.post('/messages/threads/:userId', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  const targetId = Number(req.params.userId);

  if (req.user.role === 'admin') {
    // Admins only ever have ONE staff thread: their own synthetic
    // "Super Admin" channel, keyed by their own id.
    if (targetId !== req.user.id) return res.status(400).json({ error: 'Invalid recipient.' });
  } else {
    // Super Admin messaging a User (support) or a specific Admin (internal).
    const targetUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetId);
    if (!targetUser) return res.status(404).json({ error: 'Recipient not found.' });
    if (targetUser.role === 'super_admin') return res.status(400).json({ error: 'Invalid recipient.' });
  }

  db.prepare('INSERT INTO messages (thread_user_id, sender_id, sender_role, body) VALUES (?,?,?,?)')
    .run(targetId, req.user.id, req.user.role, body.trim());
  liveEvents.broadcast('messages', ['user', 'admin', 'super_admin']);
  res.status(201).json({ ok: true });
});

// ------------------------------------------------------------------
// ANNOUNCEMENTS / BULLETIN
// ------------------------------------------------------------------
router.get('/announcements', requireAuth, (req, res) => {
  res.json({ announcements: db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 20').all() });
});

const eventMediaUpload = makeMediaUploader('event-media');

router.post('/announcements', requireAuth, requireRole('admin', 'super_admin'), eventMediaUpload.single('media'), (req, res) => {
  const { title, body, eventDate } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body are required.' });
  const mediaUrl = req.file ? `/uploads/event-media/${req.file.filename}` : null;
  const mediaType = req.file ? (req.file.mimetype.startsWith('video') ? 'video' : 'image') : null;
  const info = db.prepare('INSERT INTO announcements (title, body, event_date, media_url, media_type, created_by) VALUES (?,?,?,?,?,?)')
    .run(title, body, eventDate || null, mediaUrl, mediaType, req.user.id);
  res.status(201).json({ announcement: db.prepare('SELECT * FROM announcements WHERE id=?').get(info.lastInsertRowid) });
});

router.delete('/announcements/:id', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// PROFILE PHOTO APPROVAL QUEUE
// Regular users' avatar changes sit in pending_avatar_url until an
// Admin or Super Admin approves or rejects them.
// ------------------------------------------------------------------
router.get('/avatar-requests', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT id, full_name, username, avatar_url, pending_avatar_url
    FROM users WHERE pending_avatar_url IS NOT NULL
    ORDER BY updated_at DESC
  `).all();
  res.json({ requests: rows });
});

router.post('/avatar-requests/:userId/approve', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user || !user.pending_avatar_url) return res.status(404).json({ error: 'No pending photo request found.' });
  db.prepare("UPDATE users SET avatar_url = ?, pending_avatar_url = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(user.pending_avatar_url, user.id);
  res.json({ ok: true });
});

router.post('/avatar-requests/:userId/reject', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user || !user.pending_avatar_url) return res.status(404).json({ error: 'No pending photo request found.' });
  db.prepare("UPDATE users SET pending_avatar_url = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(user.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// NOTIFICATION COUNTS — powers the small red dot badges in the sidebar
// so Super Admin / Admin can see at a glance that something needs action.
// ------------------------------------------------------------------
// ---------------- Live updates (Server-Sent Events) ----------------
// Every logged-in page opens one long-lived connection here. When
// something relevant happens elsewhere in the system, the server pushes
// a tiny signal down this connection and the page silently refreshes
// just that piece of data — no manual reload, no waiting for the next
// scheduled poll.
//
// NOTE: this app authenticates via a Bearer token in the Authorization
// header (not a cookie) — but the browser's native EventSource API can't
// send custom headers at all. So this one endpoint accepts the same
// session token as a `?token=` query parameter instead, verified the
// exact same way as everywhere else. It's read-only (just a one-way
// notification stream) and the token is exactly as sensitive sitting in
// this same-origin URL as it already is in every other request.
router.get('/live-events', (req, res) => {
  const { verifyToken } = require('../auth');
  const token = req.query.token;
  const payload = token && verifyToken(token);
  if (!payload || payload.scope === 'complete-setup') {
    return res.status(401).json({ error: 'You are not logged in. Please log in first.' });
  }
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(payload.id);
  if (!user) return res.status(401).json({ error: 'Account not found.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  liveEvents.addClient(res, user.role);

  // Keeps intermediary proxies/load balancers from silently closing an
  // idle connection, and lets the client detect a dead connection quickly.
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveEvents.removeClient(res);
  });
});

router.get('/notification-counts', requireAuth, (req, res) => {
  if (req.user.role === 'super_admin') {
    const pendingTransactions = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE status IN ('pending','admin_approved')").get().c
      + db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE status IN ('pending','admin_approved')").get().c;
    const pendingAvatars = db.prepare("SELECT COUNT(*) c FROM users WHERE pending_avatar_url IS NOT NULL").get().c;
    const pendingBans = db.prepare("SELECT COUNT(*) c FROM ban_requests WHERE status='pending'").get().c;
    const pendingWinners = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='won' AND winner_status='admin_verified'").get().c
      + db.prepare("SELECT COUNT(*) c FROM ticket_inventory WHERE pool_result='won' AND pool_winner_status='admin_verified'").get().c;
    const pendingTicketApprovals = db.prepare("SELECT COUNT(*) c FROM ticket_inventory WHERE status='pending_approval'").get().c;
    const pendingAccountApprovals = db.prepare("SELECT COUNT(*) c FROM users WHERE approval_status='pending_approval'").get().c
      + db.prepare("SELECT COUNT(*) c FROM users WHERE approval_status='pending_email' AND code_admin_approved_by IS NOT NULL AND code_super_admin_approved_by IS NULL").get().c;
    const pendingOrders = db.prepare("SELECT COUNT(*) c FROM shop_orders WHERE status='pending_superadmin'").get().c;
    const pendingDeleteRequests = db.prepare("SELECT COUNT(*) c FROM user_delete_requests WHERE status='pending'").get().c;
    const unreadMessages = db.prepare(`
      SELECT COUNT(DISTINCT m1.thread_user_id) c FROM messages m1
      LEFT JOIN message_read_status rs ON rs.staff_user_id = ? AND rs.thread_user_id = m1.thread_user_id
      WHERE m1.sender_id != ? AND m1.id = (SELECT MAX(id) FROM messages m2 WHERE m2.thread_user_id = m1.thread_user_id)
        AND (rs.last_read_at IS NULL OR rs.last_read_at < m1.created_at)
    `).get(req.user.id, req.user.id).c;
    return res.json({ transactions: pendingTransactions, avatars: pendingAvatars, bans: pendingBans, winners: pendingWinners, tickets: pendingTicketApprovals, accounts: pendingAccountApprovals, orders: pendingOrders, deleteRequests: pendingDeleteRequests, messages: unreadMessages });
  }
  if (req.user.role === 'admin') {
    const pendingTransactions = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE status = 'pending'").get().c
      + db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE status = 'pending'").get().c;
    const pendingAvatars = db.prepare("SELECT COUNT(*) c FROM users WHERE pending_avatar_url IS NOT NULL").get().c;
    const pendingWinners = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='won' AND winner_status='pending'").get().c
      + db.prepare("SELECT COUNT(*) c FROM ticket_inventory WHERE pool_result='won' AND pool_winner_status='pending'").get().c;
    const pendingAccountApprovals = db.prepare("SELECT COUNT(*) c FROM users WHERE approval_status='pending_approval'").get().c
      + db.prepare("SELECT COUNT(*) c FROM users WHERE approval_status='pending_email' AND code_admin_approved_by IS NULL").get().c;
    const pendingOrders = db.prepare("SELECT COUNT(*) c FROM shop_orders WHERE status='pending_admin'").get().c;
    const unreadMessages = db.prepare(`
      SELECT COUNT(DISTINCT m1.thread_user_id) c FROM messages m1
      LEFT JOIN message_read_status rs ON rs.staff_user_id = ? AND rs.thread_user_id = m1.thread_user_id
      WHERE m1.sender_id != ? AND m1.id = (SELECT MAX(id) FROM messages m2 WHERE m2.thread_user_id = m1.thread_user_id)
        AND (rs.last_read_at IS NULL OR rs.last_read_at < m1.created_at)
    `).get(req.user.id, req.user.id).c;
    return res.json({ transactions: pendingTransactions, avatars: pendingAvatars, winners: pendingWinners, accounts: pendingAccountApprovals, orders: pendingOrders, messages: unreadMessages });
  }
  res.json({});
});

// ------------------------------------------------------------------
// DRAW SETTINGS — which visual engine (Wheel of Fortune, Tambiolo Sphere,
// Cyber Dice Grid, Laser Card Deck) is shown live to users, plus the
// scheduled auto-draw date/time. Editable by both Admin and Super Admin;
// whatever is set here is exactly what users see on their Live Draw page.
// ------------------------------------------------------------------
router.get('/draw-settings', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM draw_settings WHERE id = 1').get());
});

router.patch('/draw-settings', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const { activeEngine, targetDatetime, ticketThreshold, winnerCount } = req.body;
  const current = db.prepare('SELECT * FROM draw_settings WHERE id = 1').get();
  const allowedEngines = ['wheel', 'tambiolo', 'dice', 'cards'];

  // Once a schedule has been verified by Super Admin, the engine and
  // date/time are locked — nobody (not even Super Admin) can quietly change
  // them out from under a live draw. The only way to change them is to
  // Force Cancel first, which returns every dropped ticket to its owner.
  if (current.schedule_verified_by) {
    const wantsEngineChange = activeEngine !== undefined && activeEngine !== current.active_engine;
    const wantsDateChange = targetDatetime !== undefined && targetDatetime !== current.target_datetime;
    if (wantsEngineChange || wantsDateChange) {
      return res.status(409).json({ error: 'This draw is already verified and locked. Use Force Cancel Draw first if you need to change the engine or schedule.' });
    }
  }

  const engine = allowedEngines.includes(activeEngine) ? activeEngine : current.active_engine;

  // Changing the schedule date/time always resets verification — a new
  // schedule needs a fresh Super Admin check before users can drop tickets.
  const scheduleChanged = targetDatetime !== undefined && targetDatetime !== current.target_datetime;

  db.prepare(`
    UPDATE draw_settings SET
      active_engine = ?, target_datetime = ?, ticket_threshold = ?, winner_count = ?,
      schedule_verified_by = CASE WHEN ? THEN NULL ELSE schedule_verified_by END,
      schedule_verified_at = CASE WHEN ? THEN NULL ELSE schedule_verified_at END,
      updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `).run(
    engine,
    targetDatetime !== undefined ? targetDatetime : current.target_datetime,
    ticketThreshold !== undefined ? ticketThreshold : current.ticket_threshold,
    winnerCount !== undefined ? Math.max(1, parseInt(winnerCount, 10) || 1) : current.winner_count,
    scheduleChanged ? 1 : 0,
    scheduleChanged ? 1 : 0,
    req.user.id
  );
  res.json(db.prepare('SELECT * FROM draw_settings WHERE id = 1').get());
});

// Super Admin's emergency override: cancels the current draw entirely,
// returns every dropped ticket to its owner (as if never dropped), and
// unlocks the engine/schedule so a fresh one can be set.
router.post('/draw-settings/force-cancel', requireAuth, requireRole('super_admin'), (req, res) => {
  const settings = db.prepare('SELECT * FROM draw_settings WHERE id = 1').get();
  const deleteTickets = req.body?.deleteTickets === true;
  let ticketsAffected = 0;

  db.runInTransaction(() => {
    const openDraw = db.prepare("SELECT * FROM draws WHERE status = 'open' AND is_pool_draw = 1 AND draw_date = ?").get(settings.target_datetime);
    if (openDraw) {
      ticketsAffected = db.prepare('SELECT COUNT(*) c FROM ticket_inventory WHERE dropped_into_draw_id = ?').get(openDraw.id).c;
      if (deleteTickets) {
        // Permanently remove these tickets from the system entirely.
        db.prepare("DELETE FROM ticket_inventory WHERE dropped_into_draw_id = ? AND status != 'sold'").run(openDraw.id);
      } else {
        // Return them to their owners, unchanged, as if never dropped.
        db.prepare("UPDATE ticket_inventory SET dropped_into_draw_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE dropped_into_draw_id = ?").run(openDraw.id);
      }
      db.prepare("UPDATE draws SET status = 'cancelled' WHERE id = ?").run(openDraw.id);
    }
    db.prepare(`
      UPDATE draw_settings SET target_datetime = NULL, ticket_threshold = NULL,
        schedule_verified_by = NULL, schedule_verified_at = NULL, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 1
    `).run(req.user.id);
  });

  db.prepare('INSERT INTO audit_log (actor_id, actor_role, action, target, details) VALUES (?,?,?,?,?)')
    .run(req.user.id, req.user.role, 'force_cancel_draw', 'draw_settings', JSON.stringify({ deleteTickets, ticketsAffected }));
  res.json({
    ok: true,
    message: deleteTickets
      ? `Draw cancelled. ${ticketsAffected} ticket(s) permanently deleted from the system.`
      : `Draw cancelled. ${ticketsAffected} ticket(s) returned to their owners.`,
  });
});

// Super Admin verifies the schedule Admin set. Only after this can users
// drop tickets into the pool — a second pair of eyes before it goes live.
router.post('/draw-settings/verify-schedule', requireAuth, requireRole('super_admin'), (req, res) => {
  const current = db.prepare('SELECT * FROM draw_settings WHERE id = 1').get();
  if (!current.target_datetime) return res.status(400).json({ error: 'No schedule has been set yet.' });

  db.runInTransaction(() => {
    db.prepare(`
      UPDATE draw_settings SET schedule_verified_by = ?, schedule_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 1
    `).run(req.user.id);

    // The Live Draw pool needs an actual open draw to attach dropped tickets
    // to. Verifying the schedule is what makes that draw "real" — create it
    // here (unless one already exists for this exact schedule) so ticket
    // drops work immediately without a separate manual step.
    const existing = db.prepare("SELECT id FROM draws WHERE status = 'open' AND is_pool_draw = 1 AND draw_date = ?").get(current.target_datetime);
    if (!existing) {
      db.prepare(`
        INSERT INTO draws (name, draw_date, ticket_price, status, is_pool_draw, created_by)
        VALUES (?, ?, 0, 'open', 1, ?)
      `).run(`Live Draw Pool — ${new Date(current.target_datetime).toLocaleDateString()}`, current.target_datetime, req.user.id);
    }
  });

  res.json(db.prepare('SELECT * FROM draw_settings WHERE id = 1').get());
});

// ------------------------------------------------------------------
// STAFF PRESENCE — lets Admin see if Super Admin is online, and lets
// Super Admin see which Admins are online, in the Messages screen.
// "Online" = they made an API request within the last 90 seconds.
// ------------------------------------------------------------------
router.get('/staff-presence', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT id, full_name, username, role, last_seen_at, avatar_url
    FROM users WHERE role IN ('admin','super_admin') AND id != ?
    ORDER BY role, full_name
  `).all(req.user.id);
  const now = Date.now();
  const withStatus = rows.map(r => ({
    ...r,
    online: r.last_seen_at ? (now - new Date(r.last_seen_at).getTime()) < 90000 : false,
  }));
  res.json({ staff: withStatus });
});

// ------------------------------------------------------------------
// LIVE DRAW POOL STATUS — powers the wheel/tambiolo visual. Shows the
// currently open draw (if any), how many tickets have been dropped into
// its pool, and the current engine + schedule from draw_settings.
// ------------------------------------------------------------------
router.get('/draw-pool-status', requireAuth, (req, res) => {
  const settings = db.prepare('SELECT * FROM draw_settings WHERE id = 1').get();
  let openDraw = db.prepare("SELECT * FROM draws WHERE status = 'open' AND is_pool_draw = 1 ORDER BY draw_date ASC LIMIT 1").get();

  // Auto-resolve the draw once its scheduled time passes — nobody has to
  // click "Execute" manually. Whoever's browser happens to poll first after
  // the deadline triggers it; the result is identical either way.
  if (openDraw && new Date(openDraw.draw_date) <= new Date()) {
    // Atomic claim: only the FIRST request to reach this line for this draw
    // actually gets to settle it — this stops two people polling at the
    // exact same moment from both picking winners and corrupting results.
    const claimed = db.prepare("UPDATE draws SET settling_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'open' AND settling_started_at IS NULL").run(openDraw.id);
    if (claimed.changes === 0) {
      // Someone else is already settling this draw right now — just report
      // it as still "open" for this response; the next poll will see the result.
      openDraw = db.prepare('SELECT * FROM draws WHERE id = ?').get(openDraw.id);
      if (openDraw.status !== 'open') openDraw = null;
    } else {
    try {
      const pool = db.prepare('SELECT * FROM ticket_inventory WHERE dropped_into_draw_id = ?').all(openDraw.id);
      if (pool.length === 0) {
        db.prepare("UPDATE draws SET status = 'cancelled' WHERE id = ?").run(openDraw.id);
      } else {
        let winnerCount = Math.max(1, settings.winner_count || 1);
        winnerCount = Math.min(winnerCount, pool.length);
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        const winners = [];
        if (openDraw.predetermined_winner && openDraw.predetermined_approved) {
          const predetermined = shuffled.find(t => t.ticket_code === openDraw.predetermined_winner);
          if (predetermined) winners.push(predetermined);
        }
        for (const t of shuffled) {
          if (winners.length >= winnerCount) break;
          if (!winners.some(w => w.id === t.id)) winners.push(t);
        }
        db.runInTransaction(() => {
          const winnerIds = winners.map(t => t.id);
          const placeholders = winnerIds.map(() => '?').join(',') || '0';
          db.prepare(`DELETE FROM ticket_inventory WHERE dropped_into_draw_id = ? AND id NOT IN (${placeholders})`).run(openDraw.id, ...winnerIds);
          winners.forEach((t, i) => {
            db.prepare("UPDATE ticket_inventory SET pool_result = 'won', pool_rank = ? WHERE id = ?").run(i + 1, t.id);
          });
          db.prepare("UPDATE draws SET status = 'completed', winning_number = ? WHERE id = ?").run(winners[0].ticket_code, openDraw.id);
        });
      }
    } catch (settleErr) {
      // Something went wrong mid-settlement — release the lock so the next
      // poll can safely retry, instead of leaving this draw stuck forever.
      db.prepare("UPDATE draws SET settling_started_at = NULL WHERE id = ?").run(openDraw.id);
    }
    openDraw = db.prepare('SELECT * FROM draws WHERE id = ?').get(openDraw.id);
    if (openDraw.status !== 'open') openDraw = null;
    }
  }

  let poolCount = 0;
  let ticketNumbers = [];
  if (openDraw) {
    ticketNumbers = db.prepare('SELECT ticket_code FROM ticket_inventory WHERE dropped_into_draw_id = ?').all(openDraw.id).map(r => r.ticket_code);
    poolCount = ticketNumbers.length;
  }

  // No open draw right now — fall back to the most recently completed one
  // (within the last hour) so users actually get to see the reveal and
  // winner list, instead of it vanishing the instant it settles.
  let recentDraw = openDraw;
  if (!recentDraw) {
    recentDraw = db.prepare(`
      SELECT * FROM draws WHERE status = 'completed' AND is_pool_draw = 1
      AND draw_date >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute')
      ORDER BY draw_date DESC LIMIT 1
    `).get();
  }

  res.json({
    settings,
    draw: recentDraw || null,
    poolCount,
    ticketNumbers,
    scheduleVerified: !!settings.schedule_verified_by,
    // "Online" = a schedule exists at all, so users see the countdown and
    // engine building anticipation as soon as staff sets a date/time.
    // Actually being able to DROP a ticket is a separate, stricter gate
    // (scheduleVerified) — Super Admin still has to verify it first.
    isOnline: !!(settings.target_datetime || openDraw),
  });
});

router.get('/draws/:id/winners', requireAuth, (req, res) => {
  const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
  if (!draw) return res.json({ winners: [] });

  const isStaff = req.user.role === 'admin' || req.user.role === 'super_admin';

  function maskName(fullName) {
    if (!fullName) return '';
    return fullName.split(' ').map(part => {
      if (part.replace(/\./g, '').length <= 2) return part;
      const keep = Math.ceil(part.length / 2);
      return part.slice(0, keep) + '**' + part.slice(-1);
    }).join(' ');
  }

  let rows;
  if (draw.is_pool_draw) {
    rows = db.prepare(`
      SELECT ti.ticket_code as ticket_number, ti.pool_rank as rank, u.full_name as owner_name
      FROM ticket_inventory ti LEFT JOIN users u ON u.id = ti.owner_user_id
      WHERE ti.dropped_into_draw_id = ? AND ti.pool_result = 'won'
      ORDER BY ti.pool_rank ASC
    `).all(draw.id);
  } else {
    rows = db.prepare(`
      SELECT t.ticket_number, t.rank, u.full_name as owner_name
      FROM tickets t LEFT JOIN users u ON u.id = t.user_id
      WHERE t.draw_id = ? AND t.status = 'won'
      ORDER BY t.rank ASC
    `).all(draw.id);
  }

  const winners = rows.map(r => ({
    ticket_number: r.ticket_number,
    rank: r.rank,
    owner_masked: isStaff ? r.owner_name : maskName(r.owner_name),
  }));
  res.json({ winners });
});

// ------------------------------------------------------------------
// NEW ACCOUNT APPROVALS — users who have verified their email but are
// still awaiting a human check from Admin or Super Admin before they can
// log in. Either role can approve or reject.
// ------------------------------------------------------------------
router.get('/account-approvals', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT id, full_name, username, email, mobile, address, id_photo, selfie_photo, created_at, rejection_reason
    FROM users WHERE role = 'user' AND approval_status = 'pending_approval'
    ORDER BY created_at ASC
  `).all();
  res.json({ pending: rows });
});

router.post('/account-approvals/:id/approve', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND approval_status = 'pending_approval'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'No pending account found.' });
  // Their ID was reviewed as part of this same approval — no separate
  // verification step needed, they're fully verified the moment this passes.
  db.prepare("UPDATE users SET approval_status = 'approved', is_fully_verified = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(user.id);
  res.json({ ok: true });
});

router.post('/account-approvals/:id/reject', requireAuth, requireRole('admin', 'super_admin'), (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND approval_status = 'pending_approval'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'No pending account found.' });
  db.prepare("UPDATE users SET approval_status = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(user.id);
  res.json({ ok: true });
});

// Public-facing (any logged-in role) read of which background sound is
// currently deployed to which page — used by Live Draw, Shop, etc. to
// decide what to play. Uploading/deploying itself stays Admin/Super-Admin-only.
router.get('/audio-deployments', requireAuth, (req, res) => {
  const AUDIO_PAGE_KEYS = ['live_draw', 'shop', 'auction'];
  const rows = db.prepare(`
    SELECT d.page_key, d.audio_file_id, a.name, a.file_url
    FROM audio_deployments d LEFT JOIN audio_files a ON a.id = d.audio_file_id
  `).all();
  const map = {};
  AUDIO_PAGE_KEYS.forEach(key => { map[key] = null; });
  rows.forEach(r => { map[r.page_key] = r.audio_file_id ? { id: r.audio_file_id, name: r.name, file_url: r.file_url } : null; });
  res.json({ deployments: map });
});

module.exports = router;
