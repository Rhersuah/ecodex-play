const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { makeUploader, makeAudioUploader } = require('../utils/upload');
const liveEvents = require('../liveEvents');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'super_admin'));

const shopUpload = makeUploader('shop');
const qrUpload = makeUploader('ticket-qr');
const audioUpload = makeAudioUploader('audio');

function publicUser(u) { const { password_hash, ...rest } = u; return rest; }

// ---------------- Dashboard (admin's own view) ----------------
router.get('/dashboard', (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE role='user' AND approval_status != 'rejected'").get().c;
  const pendingReview = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE status='pending'").get().c
    + db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE status='pending'").get().c;
  const awaitingSuperAdmin = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE status='admin_approved'").get().c
    + db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE status='admin_approved'").get().c;
  const totalClientBalance = db.prepare("SELECT COALESCE(SUM(balance),0) s FROM users WHERE role='user'").get().s;
  res.json({ totalUsers, pendingReview, awaitingSuperAdmin, totalClientBalance });
});

// ---------------- User Management (view + ban; balance edits are super_admin only) ----------------
router.get('/users', (req, res) => {
  const users = db.prepare("SELECT * FROM users WHERE role='user' ORDER BY created_at DESC").all();
  res.json({ users: users.map(publicUser) });
});

router.patch('/users/:id/status', (req, res) => {
  const { status } = req.body;
  // Admins can only lift a ban directly. To BAN a user, they must submit a
  // request via /admin/ban-requests for Super Admin approval (2-tier flow).
  if (status !== 'active') {
    return res.status(403).json({ error: 'Admins cannot ban directly. Please submit a ban request for Super Admin approval instead.' });
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role='user'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  db.prepare("UPDATE users SET status = 'active', ban_reason = NULL, ban_expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(user.id);
  res.json({ ok: true });
});

// ---------------- Level 1 Transaction Review ----------------
function attachUserInfo(items) {
  return items.map((item) => {
    const user = db.prepare('SELECT id, full_name, mobile FROM users WHERE id = ?').get(item.user_id);
    return { ...item, user };
  });
}

router.get('/transactions/pending', (req, res) => {
  const deposits = db.prepare("SELECT *, 'deposit' as txType FROM deposit_requests WHERE status = 'pending' ORDER BY created_at ASC").all();
  const withdrawals = db.prepare("SELECT *, 'withdrawal' as txType FROM withdrawal_requests WHERE status = 'pending' ORDER BY created_at ASC").all();
  res.json({ pending: attachUserInfo([...deposits, ...withdrawals]) });
});

router.post('/transactions/:type(deposit|withdrawal)/:id/review', (req, res) => {
  const { type, id } = req.params;
  const { decision, reason } = req.body; // 'admin_approved' | 'rejected'
  if (!['admin_approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });

  const table = type === 'deposit' ? 'deposit_requests' : 'withdrawal_requests';
  const record = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!record) return res.status(404).json({ error: 'Transaction not found.' });
  if (record.status !== 'pending') return res.status(409).json({ error: 'This transaction has already been processed.' });

  db.runInTransaction(() => {
    db.prepare(`UPDATE ${table} SET status=?, reviewed_by_admin=?, reject_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
      .run(decision, req.user.id, decision === 'rejected' ? (reason || null) : null, id);
    if (decision === 'rejected' && type === 'withdrawal') {
      // Refund held funds since it never reached final approval.
      db.prepare("UPDATE users SET balance = balance + ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(record.amount, record.user_id);
    }
  });
  res.json({ ok: true });
});

// ---------------- Shop Management ----------------
router.get('/shop-items', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM shop_items ORDER BY created_at DESC').all() });
});

router.post('/shop-items', shopUpload.single('image'), (req, res) => {
  const { name, description, price, stock, discountPercent } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'Name and price are required.' });
  const imagePath = req.file ? `/uploads/shop/${req.file.filename}` : null;
  const discount = discountPercent ? Math.min(99, Math.max(0, Number(discountPercent))) : null;
  const info = db.prepare(`
    INSERT INTO shop_items (name, description, price, discount_percent, stock, image, created_by) VALUES (?,?,?,?,?,?,?)
  `).run(name, description || null, Number(price), discount, Number(stock) || 0, imagePath, req.user.id);
  res.status(201).json({ item: db.prepare('SELECT * FROM shop_items WHERE id=?').get(info.lastInsertRowid) });
});

router.patch('/shop-items/:id', shopUpload.single('image'), (req, res) => {
  const item = db.prepare('SELECT * FROM shop_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const { name, description, price, stock, isActive, discountPercent } = req.body;
  const imagePath = req.file ? `/uploads/shop/${req.file.filename}` : item.image;
  const discount = discountPercent !== undefined ? (discountPercent === '' || discountPercent === null ? null : Math.min(99, Math.max(0, Number(discountPercent)))) : item.discount_percent;
  db.prepare(`
    UPDATE shop_items SET name=?, description=?, price=?, discount_percent=?, stock=?, image=?, is_active=? WHERE id=?
  `).run(
    name || item.name, description !== undefined ? description : item.description,
    price !== undefined ? Number(price) : item.price, discount, stock !== undefined ? Number(stock) : item.stock,
    imagePath, isActive !== undefined ? (isActive ? 1 : 0) : item.is_active, item.id
  );
  res.json({ item: db.prepare('SELECT * FROM shop_items WHERE id=?').get(item.id) });
});

router.delete('/shop-items/:id', (req, res) => {
  db.prepare('DELETE FROM shop_items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/shop-orders', (req, res) => {
  const rows = db.prepare(`
    SELECT so.*, si.name as item_name, u.full_name as buyer_name
    FROM shop_orders so
    JOIN shop_items si ON si.id = so.item_id
    JOIN users u ON u.id = so.user_id
    ORDER BY so.created_at DESC
  `).all();
  res.json({ orders: rows });
});

router.patch('/shop-orders/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['fulfilled', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  db.prepare('UPDATE shop_orders SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// ---------------- Draw / Ticket Management ----------------
router.get('/draws', (req, res) => {
  res.json({ draws: db.prepare('SELECT * FROM draws ORDER BY created_at DESC').all() });
});

router.post('/draws', (req, res) => {
  const { name, drawDate, ticketPrice } = req.body;
  if (!name || !drawDate) return res.status(400).json({ error: 'Draw name and date are required.' });
  const info = db.prepare('INSERT INTO draws (name, draw_date, ticket_price, created_by) VALUES (?,?,?,?)')
    .run(name, drawDate, Number(ticketPrice) || 0, req.user.id);
  res.status(201).json({ draw: db.prepare('SELECT * FROM draws WHERE id=?').get(info.lastInsertRowid) });
});

router.patch('/draws/:id', (req, res) => {
  const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
  if (!draw) return res.status(404).json({ error: 'Not found.' });
  const { status, winningNumber, winningNumber2nd, winningNumber3rd, additionalWinners } = req.body;

  db.runInTransaction(() => {
    db.prepare(`
      UPDATE draws SET
        status = COALESCE(?, status),
        winning_number = COALESCE(?, winning_number),
        winning_number_2nd = COALESCE(?, winning_number_2nd),
        winning_number_3rd = COALESCE(?, winning_number_3rd)
      WHERE id = ?
    `).run(status || null, winningNumber || null, winningNumber2nd || null, winningNumber3rd || null, draw.id);

    if (status === 'completed' && winningNumber) {
      // Mark every ticket in this draw as lost by default, then promote the
      // designated winners to 'won' with their medal rank (1=Gold, 2=Silver,
      // 3=Bronze, 4+=consolation/normal).
      db.prepare("UPDATE tickets SET status = 'lost' WHERE draw_id = ? AND status = 'active'").run(draw.id);

      const setWinner = db.prepare("UPDATE tickets SET status = 'won', rank = ? WHERE draw_id = ? AND ticket_number = ?");
      setWinner.run(1, draw.id, winningNumber);
      if (winningNumber2nd) setWinner.run(2, draw.id, winningNumber2nd);
      if (winningNumber3rd) setWinner.run(3, draw.id, winningNumber3rd);

      db.prepare('DELETE FROM draw_winners WHERE draw_id = ?').run(draw.id);
      if (Array.isArray(additionalWinners)) {
        let rank = 4;
        for (const ticketNumber of additionalWinners) {
          if (!ticketNumber) continue;
          setWinner.run(rank, draw.id, ticketNumber);
          db.prepare('INSERT INTO draw_winners (draw_id, ticket_number, rank) VALUES (?,?,?)').run(draw.id, ticketNumber, rank);
          rank += 1;
        }
      }
    }
  });
  res.json({ draw: db.prepare('SELECT * FROM draws WHERE id=?').get(draw.id) });
});

// ---------------- Pre-Generated Ticket Inventory (ECP-####) ----------------
function generateTicketCode() {
  let code, exists;
  do {
    code = 'ECP-' + Math.floor(1000 + Math.random() * 9000);
    exists = db.prepare('SELECT id FROM ticket_inventory WHERE ticket_code = ?').get(code);
  } while (exists);
  return code;
}

router.post('/tickets/generate', qrUpload.single('qrImage'), (req, res) => {
  const { quantity, tier, price } = req.body;
  const qty = Math.max(1, Math.min(500, Number(quantity) || 1));
  const t = ['gold', 'premium'].includes(tier) ? tier : 'normal';
  const p = Number(price) || 0;
  if (p < 0) return res.status(400).json({ error: 'Invalid price.' });
  const qrImagePath = req.file ? `/uploads/ticket-qr/${req.file.filename}` : null;

  const created = [];
  const insert = db.prepare(`
    INSERT INTO ticket_inventory (ticket_code, tier, price, qr_image, status, created_by)
    VALUES (?, ?, ?, ?, 'pending_approval', ?)
  `);
  db.runInTransaction(() => {
    for (let i = 0; i < qty; i++) {
      const code = generateTicketCode();
      insert.run(code, t, p, qrImagePath, req.user.id);
      created.push(code);
    }
  });
  res.status(201).json({ ok: true, created });
  liveEvents.broadcast('tickets', ['super_admin']);
});

router.get('/tickets', (req, res) => {
  const rows = db.prepare(`
    SELECT ti.*, u.full_name as owner_name
    FROM ticket_inventory ti LEFT JOIN users u ON u.id = ti.owner_user_id
    ORDER BY ti.created_at DESC LIMIT 500
  `).all();
  res.json({ tickets: rows });
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

router.delete('/tickets/:id', (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only Super Admin can delete tickets from the system.' });
  }
  const ticket = db.prepare('SELECT * FROM ticket_inventory WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

  const force = req.query.force === 'true';
  if (ticket.status === 'sold' && !force) {
    return res.status(409).json({
      error: 'This ticket was already sold to a user. Force delete anyway? This permanently removes it from the system.',
      canForce: true,
    });
  }
  db.prepare('DELETE FROM ticket_inventory WHERE id = ?').run(ticket.id);
  res.json({ ok: true });
});

// ---------------- OTP Management (Admin can also generate, as backup to Super Admin) ----------------
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

  res.status(201).json({ ok: true, code });
});

// ---------------- Admin Settings (own preferences; changes are logged for Super Admin) ----------------
router.get('/settings', (req, res) => {
  let row = db.prepare('SELECT * FROM admin_settings WHERE user_id = ?').get(req.user.id);
  if (!row) {
    db.prepare('INSERT INTO admin_settings (user_id) VALUES (?)').run(req.user.id);
    row = db.prepare('SELECT * FROM admin_settings WHERE user_id = ?').get(req.user.id);
  }
  res.json(row);
});

router.patch('/settings', (req, res) => {
  const { defaultUserSort, usersPerPage, notifyNewBanRequests, notifyNewMessages, autoRefreshSeconds } = req.body;
  const current = db.prepare('SELECT * FROM admin_settings WHERE user_id = ?').get(req.user.id)
    || { default_user_sort: 'newest', users_per_page: 25, notify_new_ban_requests: 1, notify_new_messages: 1, auto_refresh_seconds: 30 };

  db.prepare(`
    INSERT INTO admin_settings (user_id, default_user_sort, users_per_page, notify_new_ban_requests, notify_new_messages, auto_refresh_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(user_id) DO UPDATE SET
      default_user_sort = excluded.default_user_sort,
      users_per_page = excluded.users_per_page,
      notify_new_ban_requests = excluded.notify_new_ban_requests,
      notify_new_messages = excluded.notify_new_messages,
      auto_refresh_seconds = excluded.auto_refresh_seconds,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    req.user.id,
    defaultUserSort ?? current.default_user_sort,
    usersPerPage ?? current.users_per_page,
    notifyNewBanRequests !== undefined ? (notifyNewBanRequests ? 1 : 0) : current.notify_new_ban_requests,
    notifyNewMessages !== undefined ? (notifyNewMessages ? 1 : 0) : current.notify_new_messages,
    autoRefreshSeconds ?? current.auto_refresh_seconds
  );

  // Super Admin can always see exactly what an Admin changed and when.
  db.prepare('INSERT INTO audit_log (actor_id, actor_role, action, target, details) VALUES (?,?,?,?,?)')
    .run(req.user.id, req.user.role, 'update_admin_settings', `admin:${req.user.id}`, JSON.stringify(req.body));

  res.json(db.prepare('SELECT * FROM admin_settings WHERE user_id = ?').get(req.user.id));
});

// ---------------- Winner Verification (Level 1) ----------------
router.get('/winners/pending', (req, res) => {
  const raffleWinners = db.prepare(`
    SELECT t.id, t.ticket_number, t.rank, u.full_name, u.username, u.mobile, u.email, d.name as draw_name, 'raffle' as source
    FROM tickets t
    JOIN users u ON u.id = t.user_id
    JOIN draws d ON d.id = t.draw_id
    WHERE t.status = 'won' AND t.winner_status = 'pending'
  `).all();
  const poolWinners = db.prepare(`
    SELECT ti.id, ti.ticket_code as ticket_number, ti.pool_rank as rank, u.full_name, u.username, u.mobile, u.email, d.name as draw_name, 'pool' as source
    FROM ticket_inventory ti
    JOIN users u ON u.id = ti.owner_user_id
    JOIN draws d ON d.id = ti.dropped_into_draw_id
    WHERE ti.pool_result = 'won' AND ti.pool_winner_status = 'pending'
  `).all();
  const all = [...raffleWinners, ...poolWinners].sort((a, b) => a.rank - b.rank);
  res.json({ winners: all });
});

router.post('/winners/:source/:id/verify', (req, res) => {
  const { source, id } = req.params;
  if (source === 'pool') {
    const ticket = db.prepare("SELECT * FROM ticket_inventory WHERE id = ? AND pool_result='won' AND pool_winner_status='pending'").get(id);
    if (!ticket) return res.status(404).json({ error: 'No pending winner found.' });
    db.prepare("UPDATE ticket_inventory SET pool_winner_status='admin_verified' WHERE id=?").run(ticket.id);
  } else {
    const ticket = db.prepare("SELECT * FROM tickets WHERE id = ? AND status='won' AND winner_status='pending'").get(id);
    if (!ticket) return res.status(404).json({ error: 'No pending winner found.' });
    db.prepare("UPDATE tickets SET winner_status='admin_verified' WHERE id=?").run(ticket.id);
  }
  res.json({ ok: true });
});

// ---------------- Ban Requests (Admin submits, Super Admin approves) ----------------
router.post('/ban-requests', (req, res) => {
  const { userId, banType, banEndsAt, eventName, reason } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role='user'").get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (!['permanent', 'temporary', 'event'].includes(banType)) return res.status(400).json({ error: 'Invalid ban type.' });
  if (banType === 'temporary' && !banEndsAt) return res.status(400).json({ error: 'Please specify when the temporary ban should end.' });

  const info = db.prepare(`
    INSERT INTO ban_requests (user_id, requested_by, ban_type, ban_ends_at, event_name, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, req.user.id, banType, banType === 'temporary' ? banEndsAt : null, eventName || null, reason || null);

  liveEvents.broadcast('bans', ['super_admin']);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

router.get('/ban-requests', (req, res) => {
  const rows = db.prepare(`
    SELECT br.*, u.full_name as user_name, u.username as user_username, a.full_name as requested_by_name
    FROM ban_requests br
    JOIN users u ON u.id = br.user_id
    JOIN users a ON a.id = br.requested_by
    ORDER BY br.created_at DESC LIMIT 200
  `).all();
  res.json({ requests: rows });
});

// ---------------- Pool Draw: Optional Predetermined Winner + Execute ----------------
// Admin/Super Admin may OPTIONALLY pre-set which dropped ticket wins before
// the draw runs. If Admin sets it, it needs Super Admin approval first. If
// nobody sets one, the draw is genuinely random from the pool when executed.
router.post('/draws/:id/predetermine', (req, res) => {
  const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
  if (!draw) return res.status(404).json({ error: 'Draw not found.' });
  const { ticketCode } = req.body;
  if (!ticketCode) return res.status(400).json({ error: 'A ticket code is required.' });

  const inPool = db.prepare('SELECT id FROM ticket_inventory WHERE dropped_into_draw_id = ? AND ticket_code = ?').get(draw.id, ticketCode);
  if (!inPool) return res.status(400).json({ error: 'That ticket is not in this draw\'s pool.' });

  const approved = req.user.role === 'super_admin' ? 1 : 0;
  db.prepare('UPDATE draws SET predetermined_winner = ?, predetermined_by = ?, predetermined_approved = ? WHERE id = ?')
    .run(ticketCode, req.user.id, approved, draw.id);

  res.json({
    ok: true,
    message: approved
      ? 'Predetermined winner set.'
      : 'Predetermined winner submitted — awaiting Super Admin approval before it takes effect.',
  });
});

router.post('/draws/:id/execute', (req, res) => {
  const draw = db.prepare('SELECT * FROM draws WHERE id = ?').get(req.params.id);
  if (!draw) return res.status(404).json({ error: 'Draw not found.' });
  if (draw.status !== 'open') return res.status(409).json({ error: 'This draw is not open.' });

  const pool = db.prepare('SELECT * FROM ticket_inventory WHERE dropped_into_draw_id = ?').all(draw.id);
  if (pool.length === 0) {
    return res.status(409).json({
      error: 'This pool is empty — the draw cannot start with no tickets in it. Cancel the draw instead, or wait for tickets to be dropped.',
      canCancel: true,
    });
  }

  let winnerCount = Math.max(1, parseInt(req.body?.winnerCount, 10) || 1);
  winnerCount = Math.min(winnerCount, pool.length);

  // Shuffle the pool, then pick winnerCount unique tickets in order — rank 1
  // is the predetermined winner (if set and approved), the rest are genuinely random.
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const winners = [];
  if (draw.predetermined_winner && draw.predetermined_approved) {
    const predetermined = shuffled.find(t => t.ticket_code === draw.predetermined_winner);
    if (predetermined) winners.push(predetermined);
  }
  for (const t of shuffled) {
    if (winners.length >= winnerCount) break;
    if (!winners.some(w => w.id === t.id)) winners.push(t);
  }

  db.runInTransaction(() => {
    const winnerIds = winners.map(t => t.id);
    // Losing tickets are cleaned up entirely — they have no further purpose
    // and shouldn't clutter the user's ticket list. Winners are the only
    // ones that stick around, as a genuine record of what was actually won.
    const placeholders = winnerIds.map(() => '?').join(',') || '0';
    db.prepare(`DELETE FROM ticket_inventory WHERE dropped_into_draw_id = ? AND id NOT IN (${placeholders})`).run(draw.id, ...winnerIds);
    winners.forEach((t, i) => {
      db.prepare("UPDATE ticket_inventory SET pool_result = 'won', pool_rank = ? WHERE id = ?").run(i + 1, t.id);
    });
    db.prepare("UPDATE draws SET status = 'completed', winning_number = ? WHERE id = ?").run(winners[0].ticket_code, draw.id);
  });

  res.json({ ok: true, winnerCodes: winners.map(w => w.ticket_code), wasPredetermined: !!(draw.predetermined_winner && draw.predetermined_approved) });
});

// Admin cannot delete a user directly — they submit a request that
// Super Admin must review and approve first.
router.post('/delete-requests', (req, res) => {
  const { userId, reason } = req.body;
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const existing = db.prepare("SELECT id FROM user_delete_requests WHERE target_user_id = ? AND status = 'pending'").get(userId);
  if (existing) return res.status(409).json({ error: 'A delete request for this user is already pending.' });

  db.prepare('INSERT INTO user_delete_requests (target_user_id, reason, requested_by) VALUES (?,?,?)')
    .run(userId, reason || null, req.user.id);
  res.status(201).json({ ok: true, message: 'Delete request submitted. Awaiting Super Admin approval.' });
});

// ------------------------------------------------------------------
// SIGNUP CODE RELEASE (2-tier) — since there is no automatic email
// sending in this flow, Admin manually reviews a new signup first
// (tier 1). Once Admin releases it, it moves to Super Admin (tier 2)
// for final approval before the verification code appears to the user.
// ------------------------------------------------------------------
router.get('/signup-verifications/pending', (req, res) => {
  const rows = db.prepare(`
    SELECT id, full_name, username, email, mobile, email_verification_code, created_at, rejection_reason
    FROM users
    WHERE approval_status = 'pending_email' AND code_admin_approved_by IS NULL
    ORDER BY created_at ASC
  `).all();
  res.json({ pending: rows });
});

router.post('/signup-verifications/:id/release', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND approval_status = 'pending_email'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Signup not found.' });
  db.prepare('UPDATE users SET code_admin_approved_by = ? WHERE id = ?').run(req.user.id, user.id);
  res.json({ ok: true, message: 'Released for Super Admin final approval.' });
});

router.post('/signup-verifications/:id/reject', (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND approval_status = 'pending_email'").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Signup not found.' });
  db.prepare("UPDATE users SET approval_status = 'rejected', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(user.id);
  res.json({ ok: true, message: 'Signup rejected.' });
});

// ---------------- Audio Management ----------------
// Both Admin and Super Admin can upload sounds and deploy them to pages
// (Live Draw, Shop, etc). Deployed audio only plays as *background* sound
// on the page it's assigned to — never as a "click" sound effect.
const AUDIO_PAGE_KEYS = ['live_draw', 'shop', 'auction'];

router.get('/audio', (req, res) => {
  const files = db.prepare('SELECT * FROM audio_files ORDER BY created_at DESC').all();
  res.json({ files });
});

router.post('/audio', audioUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file was uploaded.' });
  const name = req.body.name || req.file.originalname;
  const url = `/uploads/audio/${req.file.filename}`;
  const info = db.prepare('INSERT INTO audio_files (name, file_url, uploaded_by) VALUES (?,?,?)').run(name, url, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid, name, file_url: url });
});

router.delete('/audio/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'Audio file not found.' });
  db.prepare('UPDATE audio_deployments SET audio_file_id = NULL WHERE audio_file_id = ?').run(file.id);
  db.prepare('DELETE FROM audio_files WHERE id = ?').run(file.id);
  res.json({ ok: true });
});

router.post('/audio-deployments/:pageKey', (req, res) => {
  const pageKey = req.params.pageKey;
  if (!AUDIO_PAGE_KEYS.includes(pageKey)) return res.status(400).json({ error: 'Unknown page.' });
  const { audioFileId } = req.body;
  if (audioFileId) {
    const file = db.prepare('SELECT id FROM audio_files WHERE id = ?').get(audioFileId);
    if (!file) return res.status(404).json({ error: 'Audio file not found.' });
  }
  db.prepare(`
    INSERT INTO audio_deployments (page_key, audio_file_id, updated_by, updated_at) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(page_key) DO UPDATE SET audio_file_id = excluded.audio_file_id, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(pageKey, audioFileId || null, req.user.id);
  res.json({ ok: true });
});

// ---------------- Shard Collection Events ----------------
router.get('/shard-events', (req, res) => {
  const events = db.prepare('SELECT * FROM shard_events ORDER BY created_at DESC').all();
  res.json({ events });
});

const shardEventPhotoUpload = makeUploader('shard-events');

router.post('/shard-events', shardEventPhotoUpload.single('photo'), (req, res) => {
  const { name, description, durationDays } = req.body;
  let iconTypes = req.body.iconTypes;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Event name is required.' });
  const allowedIcons = ['shard', 'chest', 'coins', 'diamond'];

  // iconTypes may arrive as a JSON string (from FormData) or an array.
  if (typeof iconTypes === 'string') {
    try { iconTypes = JSON.parse(iconTypes); } catch (e) { iconTypes = [iconTypes]; }
  }
  if (!Array.isArray(iconTypes)) iconTypes = [];
  iconTypes = iconTypes.filter(t => allowedIcons.includes(t));
  if (iconTypes.length === 0) iconTypes = ['shard'];

  const endDate = durationDays ? new Date(Date.now() + Number(durationDays) * 86400000).toISOString() : null;
  const photoUrl = req.file ? `/uploads/shard-events/${req.file.filename}` : null;
  const info = db.prepare('INSERT INTO shard_events (name, description, icon_type, end_date, photo, is_active, created_by) VALUES (?,?,?,?,?,1,?)')
    .run(name.trim(), description || null, iconTypes.join(','), endDate, photoUrl, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.patch('/shard-events/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM shard_events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const { isActive } = req.body;
  db.prepare('UPDATE shard_events SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, event.id);
  res.json({ ok: true });
});

router.delete('/shard-events/:id', (req, res) => {
  const event = db.prepare('SELECT * FROM shard_events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  db.prepare('DELETE FROM shard_collections WHERE shard_event_id = ?').run(event.id);
  db.prepare('DELETE FROM shard_events WHERE id = ?').run(event.id);
  res.json({ ok: true });
});

// ---------------- Auction Management (Admin & Super Admin) ----------------
router.get('/auction-items', (req, res) => {
  const items = db.prepare(`
    SELECT ai.*, u.full_name as current_bidder_name
    FROM auction_items ai LEFT JOIN users u ON u.id = ai.current_bidder_id
    ORDER BY ai.created_at DESC
  `).all();
  res.json({ items });
});

router.get('/auction-items/:id/bids', (req, res) => {
  const bids = db.prepare(`
    SELECT ab.*, u.full_name, u.username
    FROM auction_bids ab JOIN users u ON u.id = ab.user_id
    WHERE ab.auction_item_id = ? ORDER BY ab.created_at DESC
  `).all(req.params.id);
  res.json({ bids });
});

router.post('/auction-items', shopUpload.single('image'), (req, res) => {
  const { name, description, startingPrice, minIncrement, endTime } = req.body;
  if (!name || !startingPrice || !endTime) return res.status(400).json({ error: 'Name, starting price, and end time are required.' });
  const image = req.file ? `/uploads/shop/${req.file.filename}` : null;
  const info = db.prepare(`
    INSERT INTO auction_items (name, description, image, starting_price, current_price, min_increment, end_time, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(name, description || null, image, parseFloat(startingPrice), parseFloat(startingPrice), parseFloat(minIncrement) || 1, endTime, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

function settleAuctionIfExpired(item) {
  if (item.status !== 'active') return item;
  if (new Date(item.end_time) > new Date()) return item;

  db.runInTransaction(() => {
    if (item.current_bidder_id) {
      const bidder = db.prepare('SELECT * FROM users WHERE id = ?').get(item.current_bidder_id);
      if (bidder && bidder.balance >= item.current_price) {
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(item.current_price, bidder.id);
        db.prepare("UPDATE auction_items SET status = 'ended', winner_user_id = ? WHERE id = ?").run(bidder.id, item.id);
      } else {
        // Winning bidder no longer has enough balance — auction ends with no winner.
        db.prepare("UPDATE auction_items SET status = 'ended', winner_user_id = NULL WHERE id = ?").run(item.id);
      }
    } else {
      db.prepare("UPDATE auction_items SET status = 'ended', winner_user_id = NULL WHERE id = ?").run(item.id);
    }
  });
  return db.prepare('SELECT * FROM auction_items WHERE id = ?').get(item.id);
}

router.post('/auction-items/:id/end', (req, res) => {
  const item = db.prepare('SELECT * FROM auction_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Auction item not found.' });
  if (item.status !== 'active') return res.status(409).json({ error: 'This auction is not active.' });
  db.prepare("UPDATE auction_items SET end_time = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(item.id);
  const settled = settleAuctionIfExpired(db.prepare('SELECT * FROM auction_items WHERE id = ?').get(item.id));
  res.json({ ok: true, item: settled });
});

router.post('/auction-items/:id/cancel', (req, res) => {
  const item = db.prepare('SELECT * FROM auction_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Auction item not found.' });
  if (item.status !== 'active') return res.status(409).json({ error: 'This auction is not active.' });
  db.prepare("UPDATE auction_items SET status = 'cancelled' WHERE id = ?").run(item.id);
  res.json({ ok: true });
});

// ---------------- Shop Orders — Tier 1 (Admin) ----------------
router.get('/shop-orders/pending', (req, res) => {
  const orders = db.prepare(`
    SELECT so.*, si.name as item_name, u.full_name as buyer_name, u.username as buyer_username
    FROM shop_orders so JOIN shop_items si ON si.id = so.item_id JOIN users u ON u.id = so.user_id
    WHERE so.status = 'pending_admin' ORDER BY so.created_at ASC
  `).all();
  res.json({ orders });
});

router.post('/shop-orders/:id/approve', (req, res) => {
  const order = db.prepare("SELECT * FROM shop_orders WHERE id = ? AND status = 'pending_admin'").get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found or already reviewed.' });
  db.prepare("UPDATE shop_orders SET status = 'pending_superadmin', admin_approved_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.user.id, order.id);
  res.json({ ok: true, message: 'Approved — sent to Super Admin for final review.' });
});

router.post('/shop-orders/:id/reject', (req, res) => {
  const order = db.prepare("SELECT * FROM shop_orders WHERE id = ? AND status = 'pending_admin'").get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found or already reviewed.' });
  db.runInTransaction(() => {
    const item = db.prepare('SELECT * FROM shop_items WHERE id = ?').get(order.item_id);
    if (item) db.prepare('UPDATE shop_items SET stock = stock + ? WHERE id = ?').run(order.quantity, item.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(order.total_price, order.user_id);
    db.prepare("UPDATE shop_orders SET status = 'rejected', admin_approved_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.user.id, order.id);
  });
  res.json({ ok: true, message: 'Order rejected — stock and balance refunded.' });
});

// Once Super Admin has cleared an order (status = to_ship), either role can
// mark it ready for pickup/delivery.
router.post('/shop-orders/:id/mark-to-receive', (req, res) => {
  const order = db.prepare("SELECT * FROM shop_orders WHERE id = ? AND status = 'to_ship'").get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found or not ready for this step.' });
  db.prepare("UPDATE shop_orders SET status = 'to_receive', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(order.id);
  res.json({ ok: true, message: 'Marked as ready for collection.' });
});

router.get('/shop-orders/all', (req, res) => {
  const orders = db.prepare(`
    SELECT so.*, si.name as item_name, u.full_name as buyer_name, u.username as buyer_username
    FROM shop_orders so JOIN shop_items si ON si.id = so.item_id JOIN users u ON u.id = so.user_id
    ORDER BY so.created_at DESC LIMIT 300
  `).all();
  res.json({ orders });
});

module.exports = router;
