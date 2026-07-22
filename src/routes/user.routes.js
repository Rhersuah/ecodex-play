const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { makeUploader } = require('../utils/upload');
const { VIP_TIERS, getTierByLevel } = require('../vipTiers');
const { awardPoints } = require('../pointsHelper');
const liveEvents = require('../liveEvents');

const router = express.Router();
// Admin and Super Admin can also load these pages (Shop, Auction, Live
// Draw...) to preview/monitor exactly what users see. Actions that only
// make sense for a real player — buying, bidding, dropping tickets,
// collecting shards — are blocked for staff individually below with
// requireUserRole, not at this router level.
router.use(requireAuth, requireRole('user', 'admin', 'super_admin'));

// Blocks an action to real users only — staff can look, but this specific
// button isn't for them (they don't have a wallet balance to spend, etc).
function requireUserRole(req, res, next) {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'This action is for users only — Admin and Super Admin are here to monitor, not to buy or bid.' });
  }
  next();
}

const proofUpload = makeUploader('proofs', { perUser: true });

// ---------------- Balance & My Transactions ----------------
router.get('/platform-fee', (req, res) => {
  const depositFee = db.prepare("SELECT value FROM platform_settings WHERE key = 'deposit_fee_percent'").get();
  const withdrawalFee = db.prepare("SELECT value FROM platform_settings WHERE key = 'withdrawal_fee_percent'").get();
  res.json({
    depositFeePercent: depositFee ? parseFloat(depositFee.value) : 0,
    withdrawalFeePercent: withdrawalFee ? parseFloat(withdrawalFee.value) : 0,
  });
});

router.get('/balance', (req, res) => {
  res.json({ balance: req.user.balance });
});

// ---------------- VIP Status ----------------
router.get('/vip-status', (req, res) => {
  const user = db.prepare('SELECT vip_tier, total_points, is_fully_verified FROM users WHERE id = ?').get(req.user.id);

  const currentTier = getTierByLevel(user.vip_tier);
  const nextTier = VIP_TIERS.find(t => t.tier === user.vip_tier + 1) || null;

  res.json({
    vipTier: user.vip_tier,
    vipRoman: currentTier ? currentTier.roman : null,
    isFullyVerified: !!user.is_fully_verified,
    totalPoints: user.total_points,
    nextTier,
    allTiers: VIP_TIERS,
  });
});

router.get('/transactions', (req, res) => {
  const deposits = db.prepare("SELECT id, amount, created_at, status, 'deposit' as txType, 'Deposit' as label FROM deposit_requests WHERE user_id = ?").all(req.user.id);
  const withdrawals = db.prepare("SELECT id, amount, created_at, status, 'withdrawal' as txType, 'Withdrawal' as label FROM withdrawal_requests WHERE user_id = ?").all(req.user.id);

  // Shop purchases (physical items + gold/premium tickets bought directly, and orders placed)
  const shopOrders = db.prepare(`
    SELECT so.id, so.total_price as amount, so.created_at, so.status,
           'shop_purchase' as txType, ('Shop: ' || si.name) as label
    FROM shop_orders so JOIN shop_items si ON si.id = so.item_id
    WHERE so.user_id = ?
  `).all(req.user.id);

  // ECP ticket purchases (Buy Tickets + Shop tickets), tracked by when they became "sold".
  const ticketPurchases = db.prepare(`
    SELECT id, price as amount, updated_at as created_at, 'completed' as status,
           'ticket_purchase' as txType, ('Ticket: ' || ticket_code) as label
    FROM ticket_inventory WHERE owner_user_id = ? AND status = 'sold'
  `).all(req.user.id);

  // Draw winnings — credited once Super Admin approves the win amount.
  const poolWinnings = db.prepare(`
    SELECT id, pool_winner_amount as amount, updated_at as created_at, 'completed' as status,
           'winning' as txType, ('Won Draw: ' || ticket_code) as label
    FROM ticket_inventory WHERE owner_user_id = ? AND pool_result = 'won' AND pool_winner_status = 'approved' AND pool_winner_amount IS NOT NULL
  `).all(req.user.id);

  // Auction wins (settled automatically when an auction ends).
  const auctionWins = db.prepare(`
    SELECT id, current_price as amount, end_time as created_at, 'completed' as status,
           'auction_purchase' as txType, ('Auction: ' || name) as label
    FROM auction_items WHERE winner_user_id = ? AND status = 'ended'
  `).all(req.user.id);

  const all = [...deposits, ...withdrawals, ...shopOrders, ...ticketPurchases, ...poolWinnings, ...auctionWins]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ transactions: all });
});

// ---------------- Deposit ----------------
router.post('/deposits', requireUserRole, proofUpload.single('proof'), (req, res) => {
  const { amount, gateway, referenceNote } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount.' });
  if (!gateway) return res.status(400).json({ error: 'Please select a gateway (GCash/Maya/Bank).' });
  if (!req.file) return res.status(400).json({ error: 'Please upload proof of payment.' });

  const feeRow = db.prepare("SELECT value FROM platform_settings WHERE key = 'deposit_fee_percent'").get();
  const parsedFee = feeRow ? parseFloat(feeRow.value) : 0;
  const feePercent = Number.isNaN(parsedFee) ? 0 : parsedFee;
  const feeAmount = Math.round(amt * (feePercent / 100) * 100) / 100;
  const netAmount = amt - feeAmount;

  const id = uuid();
  // Short, human-readable reference — easy for staff to say out loud or
  // match against a payment screenshot, unlike the raw UUID.
  const displayId = 'DEP-' + Date.now().toString().slice(-8);
  const proofPath = `/uploads/proofs/${req.file.filename}`;
  db.prepare(`
    INSERT INTO deposit_requests (id, user_id, amount, gateway, reference_note, proof_image, status, display_id, fee_amount, net_amount)
    VALUES (?,?,?,?,?,?,'pending',?,?,?)
  `).run(id, req.user.id, amt, gateway, referenceNote || null, proofPath, displayId, feeAmount, netAmount);

  liveEvents.broadcast('transactions', ['admin', 'super_admin']);
  res.status(201).json({ id, displayId, amount: amt, feeAmount, netAmount, message: 'Deposit request submitted. Awaiting admin review.' });
});

// ---------------- Withdrawal ----------------
// Funds are held (deducted) immediately on request to prevent overdrafting;
// refunded automatically if an admin or super admin later rejects it.
router.post('/withdrawals', requireUserRole, (req, res) => {
  const { amount, gateway, accountNumber, accountName } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount.' });
  if (!gateway || !accountNumber) return res.status(400).json({ error: 'Please complete the gateway and account number.' });

  const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  if (fresh.balance < amt) return res.status(400).json({ error: 'Insufficient balance.' });

  const feeRow = db.prepare("SELECT value FROM platform_settings WHERE key = 'withdrawal_fee_percent'").get();
  const parsedFee = feeRow ? parseFloat(feeRow.value) : 0;
  const feePercent = Number.isNaN(parsedFee) ? 0 : parsedFee;
  const feeAmount = Math.round(amt * (feePercent / 100) * 100) / 100;
  const netAmount = amt - feeAmount;

  const id = uuid();
  const displayId = 'WD-' + Date.now().toString().slice(-8);
  db.runInTransaction(() => {
    db.prepare("UPDATE users SET balance = balance - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(amt, req.user.id);
    db.prepare(`
      INSERT INTO withdrawal_requests (id, user_id, amount, gateway, account_number, account_name, status, display_id, fee_amount, net_amount)
      VALUES (?,?,?,?,?,?,'pending',?,?,?)
    `).run(id, req.user.id, amt, gateway, accountNumber, accountName || null, displayId, feeAmount, netAmount);
  });

  liveEvents.broadcast('transactions', ['admin', 'super_admin']);
  res.status(201).json({ id, displayId, amount: amt, feeAmount, netAmount, message: 'Withdrawal request submitted. The amount is held until approved.' });
});

// ---------------- Shop ----------------
router.get('/shop-items', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM shop_items WHERE is_active = 1 AND stock > 0 ORDER BY created_at DESC').all() });
});

router.post('/shop-orders', requireUserRole, (req, res) => {
  const { itemId, quantity, recipientName, recipientEmail, recipientPhone, shippingAddress } = req.body;
  const qty = Math.max(1, Number(quantity) || 1);
  const item = db.prepare('SELECT * FROM shop_items WHERE id = ? AND is_active = 1').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  if (item.stock < qty) return res.status(400).json({ error: 'Insufficient stock.' });

  if (!recipientName || !recipientName.trim()) return res.status(400).json({ error: 'Full name is required.' });
  if (!shippingAddress || !shippingAddress.trim()) return res.status(400).json({ error: 'Shipping address is required.' });

  // Uses the ID already on file from registration — no need to re-upload
  // for every single order.
  const account = db.prepare('SELECT id_photo FROM users WHERE id = ?').get(req.user.id);
  if (!account || !account.id_photo) return res.status(400).json({ error: 'No verified ID on file — please contact support.' });

  const total = item.price * qty * (item.discount_percent ? (1 - item.discount_percent / 100) : 1);
  const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  if (fresh.balance < total) return res.status(400).json({ error: 'Insufficient balance.' });

  const id = uuid();
  db.runInTransaction(() => {
    db.prepare("UPDATE users SET balance = balance - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(total, req.user.id);
    db.prepare('UPDATE shop_items SET stock = stock - ? WHERE id = ?').run(qty, item.id);
    db.prepare(`
      INSERT INTO shop_orders (id, user_id, item_id, quantity, total_price, status, recipient_name, recipient_email, recipient_phone, shipping_address, id_photo)
      VALUES (?,?,?,?,?,'pending_admin',?,?,?,?,?)
    `).run(id, req.user.id, item.id, qty, total, recipientName.trim(), recipientEmail || null, recipientPhone || null, shippingAddress.trim(), account.id_photo);
  });
  awardPoints(db, req.user.id, 'shop', total);

  liveEvents.broadcast('orders', ['admin', 'super_admin']);
  res.status(201).json({ id, message: 'Order submitted! Waiting for Admin review.' });
});

router.get('/shop-orders/mine', (req, res) => {
  const orders = db.prepare(`
    SELECT so.*, si.name as item_name, si.image as item_image
    FROM shop_orders so JOIN shop_items si ON si.id = so.item_id
    WHERE so.user_id = ? ORDER BY so.created_at DESC
  `).all(req.user.id);
  res.json({ orders });
});

router.post('/shop-orders/:id/confirm-receipt', requireUserRole, (req, res) => {
  const order = db.prepare('SELECT * FROM shop_orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'to_receive') return res.status(409).json({ error: 'This order is not ready to be marked as received yet.' });
  db.prepare("UPDATE shop_orders SET status = 'received', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(order.id);
  res.json({ ok: true, message: 'Thanks for confirming! Order marked as received.' });
});

router.get('/shop-orders', (req, res) => {
  const rows = db.prepare(`
    SELECT so.*, si.name as item_name, si.image as item_image
    FROM shop_orders so JOIN shop_items si ON si.id = so.item_id
    WHERE so.user_id = ? ORDER BY so.created_at DESC
  `).all(req.user.id);
  res.json({ orders: rows });
});

// ---------------- Draws / Tickets ----------------
router.get('/draws', (req, res) => {
  res.json({ draws: db.prepare("SELECT * FROM draws WHERE status IN ('open','closed','completed') AND is_pool_draw = 0 ORDER BY draw_date DESC").all() });
});

router.post('/tickets/buy', requireUserRole, (req, res) => {
  const { drawId, ticketNumber } = req.body;
  const draw = db.prepare("SELECT * FROM draws WHERE id = ? AND status = 'open'").get(drawId);
  if (!draw) return res.status(404).json({ error: 'This draw is not available.' });
  if (!ticketNumber || !ticketNumber.trim()) return res.status(400).json({ error: 'Please select a ticket number.' });

  const taken = db.prepare('SELECT id FROM tickets WHERE draw_id = ? AND ticket_number = ? AND status != ?').get(drawId, ticketNumber, 'cancelled');
  if (taken) return res.status(409).json({ error: 'This ticket number has already been taken.' });

  const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  if (fresh.balance < draw.ticket_price) return res.status(400).json({ error: 'Insufficient balance.' });

  const id = uuid();
  db.runInTransaction(() => {
    db.prepare("UPDATE users SET balance = balance - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(draw.ticket_price, req.user.id);
    db.prepare('INSERT INTO tickets (id, user_id, draw_id, ticket_number) VALUES (?,?,?,?)').run(id, req.user.id, drawId, ticketNumber.trim());
  });
  awardPoints(db, req.user.id, 'ticket', draw.ticket_price);

  res.status(201).json({ id, message: 'Ticket purchased!' });
});

router.get('/tickets/mine', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, d.name as draw_name, d.draw_date, d.status as draw_status, d.winning_number
    FROM tickets t JOIN draws d ON d.id = t.draw_id
    WHERE t.user_id = ? ORDER BY t.created_at DESC
  `).all(req.user.id);
  res.json({ tickets: rows });
});

// ---------------- Shop-style Pre-Generated Ticket Inventory (ECP-####) ----------------
// Normal tier tickets appear in the Buy Tickets marketplace.
router.get('/tickets/shop', (req, res) => {
  // Buy Tickets marketplace shows any tier (normal, gold, premium) as long
  // as staff explicitly deployed it there.
  const rows = db.prepare("SELECT id, ticket_code, tier, price, qr_image FROM ticket_inventory WHERE status = 'deployed' AND deploy_destination = 'buy_tickets' ORDER BY created_at DESC").all();
  res.json({ tickets: rows });
});

// Any tier deployed specifically to the Shop shows here, alongside physical items.
router.get('/tickets/shop-gold', (req, res) => {
  const rows = db.prepare("SELECT id, ticket_code, tier, price, qr_image FROM ticket_inventory WHERE status = 'deployed' AND deploy_destination = 'shop' ORDER BY created_at DESC").all();
  res.json({ tickets: rows });
});

router.post('/tickets/shop/:id/buy', requireUserRole, (req, res) => {
  const ticket = db.prepare("SELECT * FROM ticket_inventory WHERE id = ? AND status = 'deployed'").get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'This ticket is no longer available.' });

  const fresh = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  if (fresh.balance < ticket.price) return res.status(400).json({ error: 'Insufficient balance.' });

  db.runInTransaction(() => {
    db.prepare("UPDATE users SET balance = balance - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(ticket.price, req.user.id);
    db.prepare("UPDATE ticket_inventory SET status='sold', owner_user_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(req.user.id, ticket.id);
  });
  awardPoints(db, req.user.id, 'ticket', ticket.price);

  res.status(201).json({ ok: true, ticket_code: ticket.ticket_code });
});

router.get('/tickets/inventory/mine', (req, res) => {
  const rows = db.prepare("SELECT * FROM ticket_inventory WHERE owner_user_id = ? ORDER BY updated_at DESC").all(req.user.id);
  res.json({ tickets: rows });
});

// Drop an owned ECP ticket into the pool for the currently open draw.
router.post('/tickets/inventory/:id/drop', requireUserRole, (req, res) => {
  const ticket = db.prepare("SELECT * FROM ticket_inventory WHERE id = ? AND owner_user_id = ?").get(req.params.id, req.user.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (ticket.tier !== 'normal') return res.status(400).json({ error: 'Only Normal tier tickets can be dropped into the pool. Gold tier tickets are sold directly in the Shop.' });
  if (ticket.dropped_into_draw_id) return res.status(409).json({ error: 'This ticket has already been dropped into a pool.' });

  // The draw schedule must be set by Admin AND verified by Super Admin
  // before any ticket can be dropped into the live pool.
  const settings = db.prepare('SELECT * FROM draw_settings WHERE id = 1').get();
  if (!settings.target_datetime) {
    return res.status(409).json({ error: 'No draw has been scheduled yet. Please check back later.' });
  }
  if (!settings.schedule_verified_by) {
    return res.status(409).json({ error: 'This schedule is awaiting Super Admin verification before tickets can be dropped.' });
  }

  let openDraw = db.prepare("SELECT * FROM draws WHERE status = 'open' AND is_pool_draw = 1 ORDER BY draw_date ASC LIMIT 1").get();
  if (!openDraw) {
    // Self-healing: the schedule was verified but no linked draw exists yet
    // (e.g. verified before this auto-creation existed). Create it now
    // rather than blocking the user with a confusing error.
    const info = db.prepare(`
      INSERT INTO draws (name, draw_date, ticket_price, status, is_pool_draw, created_by)
      VALUES (?, ?, 0, 'open', 1, ?)
    `).run(`Live Draw Pool — ${new Date(settings.target_datetime).toLocaleDateString()}`, settings.target_datetime, settings.schedule_verified_by);
    openDraw = db.prepare('SELECT * FROM draws WHERE id = ?').get(info.lastInsertRowid);
  }

  db.prepare("UPDATE ticket_inventory SET dropped_into_draw_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(openDraw.id, ticket.id);
  res.json({ ok: true, drawId: openDraw.id });
});

// ---------------- OTP Verification ----------------
router.post('/otp/verify', requireUserRole, (req, res) => {
  const { code, relatedType, relatedId } = req.body;
  if (!code || !relatedType || !relatedId) {
    return res.status(400).json({ error: 'Code and transaction reference are required.' });
  }

  const otp = db.prepare(`
    SELECT * FROM otp_codes
    WHERE user_id = ? AND code = ? AND related_type = ? AND related_id = ? AND used = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(req.user.id, code, relatedType, String(relatedId));

  if (!otp) return res.status(400).json({ error: 'Invalid verification code.' });
  if (new Date(otp.expires_at) < new Date()) return res.status(400).json({ error: 'This code has expired. Please request a new one.' });

  db.runInTransaction(() => {
    db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(otp.id);
    if (relatedType === 'withdrawal') {
      db.prepare("UPDATE withdrawal_requests SET otp_verified = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND user_id = ?")
        .run(relatedId, req.user.id);
    }
  });

  res.json({ ok: true, message: 'Verified successfully!' });
});

// ---------------- Personal Settings (own preferences; changes are logged for Super Admin) ----------------
router.get('/settings', requireAuth, (req, res) => {
  let row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
  if (!row) {
    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(req.user.id);
    row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
  }
  res.json(row);
});

router.patch('/settings', requireAuth, (req, res) => {
  const { notifyNewMessages, notifyTransactionUpdates, notifyDrawResults, defaultDashboardView } = req.body;
  const current = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id)
    || { notify_new_messages: 1, notify_transaction_updates: 1, notify_draw_results: 1, default_dashboard_view: 'summary' };

  db.prepare(`
    INSERT INTO user_settings (user_id, notify_new_messages, notify_transaction_updates, notify_draw_results, default_dashboard_view, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(user_id) DO UPDATE SET
      notify_new_messages = excluded.notify_new_messages,
      notify_transaction_updates = excluded.notify_transaction_updates,
      notify_draw_results = excluded.notify_draw_results,
      default_dashboard_view = excluded.default_dashboard_view,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    req.user.id,
    notifyNewMessages !== undefined ? (notifyNewMessages ? 1 : 0) : current.notify_new_messages,
    notifyTransactionUpdates !== undefined ? (notifyTransactionUpdates ? 1 : 0) : current.notify_transaction_updates,
    notifyDrawResults !== undefined ? (notifyDrawResults ? 1 : 0) : current.notify_draw_results,
    defaultDashboardView ?? current.default_dashboard_view
  );

  // Super Admin can always see what a user changed in their own settings.
  db.prepare('INSERT INTO audit_log (actor_id, actor_role, action, target, details) VALUES (?,?,?,?,?)')
    .run(req.user.id, req.user.role, 'update_user_settings', `user:${req.user.id}`, JSON.stringify(req.body));

  res.json(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id));
});

// ---------------- Shard Collection Event (daily, random amount) ----------------
// Rolls how many shards a user gets today. Weighted so small amounts are
// common and the maximum (20) is very rare — this is NOT a flat 1-20
// uniform roll on purpose.
function rollShardAmount() {
  const roll = Math.random();
  if (roll < 0.01) return 20;                                  // 1% — jackpot
  if (roll < 0.05) return 16 + Math.floor(Math.random() * 4);   // 4% — 16-19
  if (roll < 0.20) return 11 + Math.floor(Math.random() * 5);   // 15% — 11-15
  if (roll < 0.50) return 6 + Math.floor(Math.random() * 5);    // 30% — 6-10
  return 1 + Math.floor(Math.random() * 5);                     // 50% — 1-5
}

// Shard collection "resets" at 8:00 AM local time, not midnight. So if it's
// currently 2 AM, that still counts as the PREVIOUS day's collection window
// — a user who collected at 11 PM can't collect again at 2 AM claiming it's
// "a new day". Once it passes 8 AM, a fresh day begins.
function todayDateString() {
  const now = new Date();
  const shifted = new Date(now.getTime() - 8 * 60 * 60 * 1000); // shift so 8AM becomes the new "midnight"
  return shifted.toISOString().slice(0, 10);
}

router.get('/shard-status', (req, res) => {
  let event = db.prepare("SELECT * FROM shard_events WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1").get();
  if (event && event.end_date && new Date(event.end_date) <= new Date()) {
    db.prepare("UPDATE shard_events SET is_active = 0 WHERE id = ?").run(event.id);
    event = null;
  }
  if (!event) return res.json({ active: false });

  const today = todayDateString();
  const already = db.prepare('SELECT amount, item_type FROM shard_collections WHERE user_id = ? AND shard_event_id = ? AND collected_date = ?')
    .get(req.user.id, event.id, today);

  res.json({
    active: true,
    event: { id: event.id, name: event.name, description: event.description, iconType: event.icon_type, endDate: event.end_date, photo: event.photo },
    alreadyCollectedToday: !!already,
    todaysAmount: already ? already.amount : null,
    todaysItemType: already ? already.item_type : null,
  });
});

router.post('/shard-collect', requireUserRole, (req, res) => {
  const event = db.prepare("SELECT * FROM shard_events WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1").get();
  if (!event) return res.status(409).json({ error: 'There is no active shard event right now.' });

  const today = todayDateString();
  const already = db.prepare('SELECT id FROM shard_collections WHERE user_id = ? AND shard_event_id = ? AND collected_date = ?')
    .get(req.user.id, event.id, today);
  if (already) return res.status(409).json({ error: 'You already collected your shards today. Come back tomorrow!' });

  const amount = rollShardAmount();
  // If staff selected multiple icon types for this event, each collection
  // randomly lands on ONE of them — not literally all types at once.
  const availableTypes = event.icon_type.split(',').map(t => t.trim()).filter(Boolean);
  const itemType = availableTypes[Math.floor(Math.random() * availableTypes.length)] || 'shard';

  db.prepare('INSERT INTO shard_collections (user_id, shard_event_id, amount, collected_date, item_type) VALUES (?,?,?,?,?)')
    .run(req.user.id, event.id, amount, today, itemType);

  res.json({ ok: true, amount, itemType });
});

router.get('/inventory', (req, res) => {
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) c FROM shard_collections WHERE user_id = ?').get(req.user.id).c;
  const byType = db.prepare(`
    SELECT item_type, COALESCE(SUM(amount),0) as count
    FROM shard_collections WHERE user_id = ? GROUP BY item_type ORDER BY count DESC
  `).all(req.user.id);
  const history = db.prepare(`
    SELECT sc.amount, sc.collected_date, sc.item_type, se.name as event_name
    FROM shard_collections sc JOIN shard_events se ON se.id = sc.shard_event_id
    WHERE sc.user_id = ? ORDER BY sc.collected_date DESC LIMIT 60
  `).all(req.user.id);
  res.json({ totalShards: total, byType, history });
});

// ---------------- Auction (users) ----------------
function settleAuctionIfExpired(item) {
  if (item.status !== 'active') return item;
  if (new Date(item.end_time) > new Date()) return item;

  db.runInTransaction(() => {
    if (item.current_bidder_id) {
      const bidder = db.prepare('SELECT * FROM users WHERE id = ?').get(item.current_bidder_id);
      if (bidder && bidder.balance >= item.current_price) {
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(item.current_price, bidder.id);
        db.prepare("UPDATE auction_items SET status = 'ended', winner_user_id = ? WHERE id = ?").run(bidder.id, item.id);
        awardPoints(db, bidder.id, 'auction', item.current_price);
      } else {
        db.prepare("UPDATE auction_items SET status = 'ended', winner_user_id = NULL WHERE id = ?").run(item.id);
      }
    } else {
      db.prepare("UPDATE auction_items SET status = 'ended', winner_user_id = NULL WHERE id = ?").run(item.id);
    }
  });
  return db.prepare('SELECT * FROM auction_items WHERE id = ?').get(item.id);
}

router.get('/auction-items', (req, res) => {
  let items = db.prepare("SELECT * FROM auction_items WHERE status = 'active' ORDER BY end_time ASC").all();
  items = items.map(settleAuctionIfExpired).filter(i => i.status === 'active');
  res.json({ items });
});

router.get('/auction-items/:id', (req, res) => {
  let item = db.prepare('SELECT * FROM auction_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Auction item not found.' });
  item = settleAuctionIfExpired(item);
  const bidCount = db.prepare('SELECT COUNT(*) c FROM auction_bids WHERE auction_item_id = ?').get(item.id).c;
  const isWinning = item.current_bidder_id === req.user.id;
  const wonByMe = item.status === 'ended' && item.winner_user_id === req.user.id;
  res.json({ item: { ...item, bidCount, isWinning, wonByMe } });
});

router.post('/auction-items/:id/bid', requireUserRole, (req, res) => {
  let item = db.prepare('SELECT * FROM auction_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Auction item not found.' });
  item = settleAuctionIfExpired(item);
  if (item.status !== 'active') return res.status(409).json({ error: 'This auction has already ended.' });

  const { amount } = req.body;
  const bidAmount = parseFloat(amount);
  const minValid = item.current_price + item.min_increment;
  if (!bidAmount || bidAmount < minValid) {
    return res.status(400).json({ error: `Your bid must be at least ₱${minValid.toFixed(2)}.` });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.balance < bidAmount) {
    return res.status(400).json({ error: 'Your balance is not enough to cover this bid.' });
  }
  if (item.current_bidder_id === req.user.id) {
    return res.status(400).json({ error: 'You are already the highest bidder.' });
  }

  db.runInTransaction(() => {
    db.prepare('INSERT INTO auction_bids (auction_item_id, user_id, amount) VALUES (?,?,?)').run(item.id, req.user.id, bidAmount);
    db.prepare('UPDATE auction_items SET current_price = ?, current_bidder_id = ? WHERE id = ?').run(bidAmount, req.user.id, item.id);
  });

  res.json({ ok: true, currentPrice: bidAmount });
});

router.get('/auction-items/:id/bids', (req, res) => {
  const bids = db.prepare(`
    SELECT ab.amount, ab.created_at, u.full_name
    FROM auction_bids ab JOIN users u ON u.id = ab.user_id
    WHERE ab.auction_item_id = ? ORDER BY ab.created_at DESC LIMIT 50
  `).all(req.params.id);
  res.json({ bids });
});

router.get('/auction-wins', (req, res) => {
  const wins = db.prepare("SELECT * FROM auction_items WHERE winner_user_id = ? ORDER BY end_time DESC").all(req.user.id);
  res.json({ wins });
});

module.exports = router;
