// src/db.js
// Uses Node's BUILT-IN SQLite module (node:sqlite) — no native compilation
// required (no Python / Visual Studio Build Tools needed on Windows).
// Requires Node.js 22.5+ (stable in later versions). The API is
// synchronous, same shape as better-sqlite3: db.prepare(sql).get/all/run().
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// DATA_DIR lets a single persistent disk (e.g. Render's one-disk-per-service
// limit) host both the database AND the uploads folder. Locally it defaults
// to the project folder itself, so nothing changes for local development.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_PATH = path.join(DATA_DIR, 'data', 'ecodex.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// better-sqlite3 has a built-in db.transaction(fn) helper; node:sqlite does
// not, so we provide an equivalent: runInTransaction(() => { ... }).
db.runInTransaction = function runInTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    throw err;
  }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('super_admin','admin','user')),
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  mobile TEXT,
  id_number TEXT,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  pending_avatar_url TEXT,
  balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','banned')),
  ban_reason TEXT,
  ban_expires_at TEXT,
  last_seen_at TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_temp_credential INTEGER NOT NULL DEFAULT 0,
  password_reset_only INTEGER NOT NULL DEFAULT 0,
  oauth_provider TEXT,
  oauth_id TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_verification_code TEXT,
  email_verification_expires_at TEXT,
  code_admin_approved_by INTEGER,
  code_super_admin_approved_by INTEGER,
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK(approval_status IN ('pending_email','pending_approval','approved','rejected')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS deposit_destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  qr_image TEXT,
  instructions TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS deposit_requests (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  gateway TEXT NOT NULL,
  reference_note TEXT,
  proof_image TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','admin_approved','approved','rejected')),
  reviewed_by_admin INTEGER,
  reviewed_by_super_admin INTEGER,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  gateway TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','admin_approved','approved','rejected')),
  reviewed_by_admin INTEGER,
  reviewed_by_super_admin INTEGER,
  reject_reason TEXT,
  otp_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  discount_percent INTEGER,
  stock INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS shop_orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id INTEGER NOT NULL REFERENCES shop_items(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  total_price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_admin' CHECK(status IN ('pending_admin','pending_superadmin','to_ship','to_receive','received','rejected','cancelled')),
  recipient_name TEXT,
  recipient_email TEXT,
  recipient_phone TEXT,
  shipping_address TEXT,
  id_photo TEXT,
  admin_approved_by INTEGER,
  super_admin_approved_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  draw_date TEXT NOT NULL,
  ticket_price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','completed','cancelled')),
  winning_number TEXT,
  winning_number_2nd TEXT,
  winning_number_3rd TEXT,
  predetermined_winner TEXT,
  predetermined_by INTEGER,
  predetermined_approved INTEGER NOT NULL DEFAULT 0,
  is_pool_draw INTEGER NOT NULL DEFAULT 0,
  settling_started_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  draw_id INTEGER NOT NULL REFERENCES draws(id),
  ticket_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','won','lost','cancelled')),
  winner_status TEXT NOT NULL DEFAULT 'pending' CHECK(winner_status IN ('pending','admin_verified','approved')),
  rank INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_user_id INTEGER NOT NULL REFERENCES users(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  purpose TEXT NOT NULL,
  related_type TEXT,
  related_id TEXT,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  event_date TEXT,
  media_url TEXT,
  media_type TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_role TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Single-row table controlling the site-wide status banner/lockout screen.
CREATE TABLE IF NOT EXISTS system_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online','maintenance','updating','shutdown')),
  message TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO system_status (id, status) VALUES (1, 'online');

-- Single-row table letting Super Admin manually override dashboard counters
-- (issued tickets, winners, members count) shown on the dashboard, separate
-- from the real underlying data.
CREATE TABLE IF NOT EXISTS dashboard_overrides (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued_tickets_override INTEGER,
  winners_override INTEGER,
  members_override INTEGER,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO dashboard_overrides (id) VALUES (1);

-- Pre-generated tickets (ECP-####) created by Admin, approved by Super Admin,
-- then deployed for sale to users. Separate from the raffle "draws" system.
CREATE TABLE IF NOT EXISTS ticket_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_code TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'normal' CHECK(tier IN ('normal','gold','premium')),
  price REAL NOT NULL DEFAULT 0,
  qr_image TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('pending_approval','approved','rejected','deployed','sold')),
  owner_user_id INTEGER REFERENCES users(id),
  dropped_into_draw_id INTEGER REFERENCES draws(id),
  pool_result TEXT CHECK(pool_result IS NULL OR pool_result IN ('won','lost')),
  pool_rank INTEGER,
  pool_winner_status TEXT NOT NULL DEFAULT 'pending' CHECK(pool_winner_status IN ('pending','admin_verified','approved')),
  pool_winner_amount REAL,
  deploy_destination TEXT CHECK(deploy_destination IS NULL OR deploy_destination IN ('buy_tickets','shop','auction')),
  created_by INTEGER,
  approved_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Lightweight migration: add OAuth columns if upgrading an existing database
// that was created before this feature existed (SQLite's CREATE TABLE IF NOT
// EXISTS won't add columns to an already-existing table).
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userColumns.includes('oauth_provider')) db.exec("ALTER TABLE users ADD COLUMN oauth_provider TEXT");
if (!userColumns.includes('oauth_id')) db.exec("ALTER TABLE users ADD COLUMN oauth_id TEXT");
if (!userColumns.includes('pending_avatar_url')) db.exec("ALTER TABLE users ADD COLUMN pending_avatar_url TEXT");

const withdrawalColumns = db.prepare("PRAGMA table_info(withdrawal_requests)").all().map(c => c.name);
if (!withdrawalColumns.includes('otp_verified')) db.exec("ALTER TABLE withdrawal_requests ADD COLUMN otp_verified INTEGER NOT NULL DEFAULT 0");

const otpColumns = db.prepare("PRAGMA table_info(otp_codes)").all().map(c => c.name);
if (!otpColumns.includes('related_type')) db.exec("ALTER TABLE otp_codes ADD COLUMN related_type TEXT");
if (!otpColumns.includes('related_id')) db.exec("ALTER TABLE otp_codes ADD COLUMN related_id TEXT");
if (!otpColumns.includes('created_by')) db.exec("ALTER TABLE otp_codes ADD COLUMN created_by INTEGER");

const usersColumns2 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!usersColumns2.includes('ban_expires_at')) db.exec("ALTER TABLE users ADD COLUMN ban_expires_at TEXT");
if (!usersColumns2.includes('last_seen_at')) db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
if (!usersColumns2.includes('email_verified')) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1"); // existing users grandfathered in as verified
if (!usersColumns2.includes('email_verification_code')) db.exec("ALTER TABLE users ADD COLUMN email_verification_code TEXT");
if (!usersColumns2.includes('email_verification_expires_at')) db.exec("ALTER TABLE users ADD COLUMN email_verification_expires_at TEXT");
if (!usersColumns2.includes('approval_status')) db.exec("ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'"); // existing users grandfathered in as approved
if (!usersColumns2.includes('password_reset_only')) db.exec("ALTER TABLE users ADD COLUMN password_reset_only INTEGER NOT NULL DEFAULT 0");
if (!usersColumns2.includes('code_admin_approved_by')) db.exec("ALTER TABLE users ADD COLUMN code_admin_approved_by INTEGER");
if (!usersColumns2.includes('code_super_admin_approved_by')) db.exec("ALTER TABLE users ADD COLUMN code_super_admin_approved_by INTEGER");
if (!usersColumns2.includes('address')) db.exec("ALTER TABLE users ADD COLUMN address TEXT");
if (!usersColumns2.includes('id_photo')) db.exec("ALTER TABLE users ADD COLUMN id_photo TEXT");
if (!usersColumns2.includes('signup_ip')) db.exec("ALTER TABLE users ADD COLUMN signup_ip TEXT");
if (!usersColumns2.includes('rejection_reason')) db.exec("ALTER TABLE users ADD COLUMN rejection_reason TEXT");
if (!usersColumns2.includes('vip_tier')) db.exec("ALTER TABLE users ADD COLUMN vip_tier INTEGER NOT NULL DEFAULT 0");
if (!usersColumns2.includes('total_points')) db.exec("ALTER TABLE users ADD COLUMN total_points REAL NOT NULL DEFAULT 0");
if (!usersColumns2.includes('selfie_photo')) db.exec("ALTER TABLE users ADD COLUMN selfie_photo TEXT");
if (!usersColumns2.includes('is_fully_verified')) {
  db.exec("ALTER TABLE users ADD COLUMN is_fully_verified INTEGER NOT NULL DEFAULT 0");
  // Existing accounts that were already approved before this column
  // existed are retroactively marked verified — their ID was already
  // reviewed as part of that same approval.
  db.exec("UPDATE users SET is_fully_verified = 1 WHERE approval_status = 'approved'");
}

const drawsColumns = db.prepare("PRAGMA table_info(draws)").all().map(c => c.name);
if (!drawsColumns.includes('predetermined_winner')) db.exec("ALTER TABLE draws ADD COLUMN predetermined_winner TEXT");
if (!drawsColumns.includes('predetermined_by')) db.exec("ALTER TABLE draws ADD COLUMN predetermined_by INTEGER");
if (!drawsColumns.includes('predetermined_approved')) db.exec("ALTER TABLE draws ADD COLUMN predetermined_approved INTEGER NOT NULL DEFAULT 0");
if (!drawsColumns.includes('winning_number_2nd')) db.exec("ALTER TABLE draws ADD COLUMN winning_number_2nd TEXT");
if (!drawsColumns.includes('winning_number_3rd')) db.exec("ALTER TABLE draws ADD COLUMN winning_number_3rd TEXT");
if (!drawsColumns.includes('is_pool_draw')) db.exec("ALTER TABLE draws ADD COLUMN is_pool_draw INTEGER NOT NULL DEFAULT 0");
if (!drawsColumns.includes('settling_started_at')) db.exec("ALTER TABLE draws ADD COLUMN settling_started_at TEXT");

const ticketsColumns = db.prepare("PRAGMA table_info(tickets)").all().map(c => c.name);
if (!ticketsColumns.includes('winner_status')) db.exec("ALTER TABLE tickets ADD COLUMN winner_status TEXT NOT NULL DEFAULT 'pending'");
if (!ticketsColumns.includes('rank')) db.exec("ALTER TABLE tickets ADD COLUMN rank INTEGER");

const ticketInventoryColumns = db.prepare("PRAGMA table_info(ticket_inventory)").all().map(c => c.name);
if (!ticketInventoryColumns.includes('qr_image')) db.exec("ALTER TABLE ticket_inventory ADD COLUMN qr_image TEXT");
if (!ticketInventoryColumns.includes('dropped_into_draw_id')) db.exec("ALTER TABLE ticket_inventory ADD COLUMN dropped_into_draw_id INTEGER");
if (!ticketInventoryColumns.includes('pool_result')) db.exec("ALTER TABLE ticket_inventory ADD COLUMN pool_result TEXT");
if (!ticketInventoryColumns.includes('pool_rank')) db.exec("ALTER TABLE ticket_inventory ADD COLUMN pool_rank INTEGER");
if (!ticketInventoryColumns.includes('deploy_destination')) db.exec("ALTER TABLE ticket_inventory ADD COLUMN deploy_destination TEXT");

const shopItemsColumns = db.prepare("PRAGMA table_info(shop_items)").all().map(c => c.name);
if (!shopItemsColumns.includes('discount_percent')) db.exec("ALTER TABLE shop_items ADD COLUMN discount_percent INTEGER");

// Migrate shop_orders to the full order/shipping workflow (name, address,
// ID photo, 2-tier approval, shipping status) if this database predates it.
const shopOrdersColumns = db.prepare("PRAGMA table_info(shop_orders)").all().map(c => c.name);
if (!shopOrdersColumns.includes('recipient_name')) db.exec("ALTER TABLE shop_orders ADD COLUMN recipient_name TEXT");
if (!shopOrdersColumns.includes('recipient_email')) db.exec("ALTER TABLE shop_orders ADD COLUMN recipient_email TEXT");
if (!shopOrdersColumns.includes('recipient_phone')) db.exec("ALTER TABLE shop_orders ADD COLUMN recipient_phone TEXT");
if (!shopOrdersColumns.includes('shipping_address')) db.exec("ALTER TABLE shop_orders ADD COLUMN shipping_address TEXT");
if (!shopOrdersColumns.includes('id_photo')) db.exec("ALTER TABLE shop_orders ADD COLUMN id_photo TEXT");
if (!shopOrdersColumns.includes('admin_approved_by')) db.exec("ALTER TABLE shop_orders ADD COLUMN admin_approved_by INTEGER");
if (!shopOrdersColumns.includes('super_admin_approved_by')) db.exec("ALTER TABLE shop_orders ADD COLUMN super_admin_approved_by INTEGER");
if (!shopOrdersColumns.includes('updated_at')) {
  db.exec("ALTER TABLE shop_orders ADD COLUMN updated_at TEXT");
  db.exec("UPDATE shop_orders SET updated_at = created_at WHERE updated_at IS NULL");
}

const shopOrdersConstraintSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shop_orders'").get();
if (shopOrdersConstraintSql && shopOrdersConstraintSql.sql && !shopOrdersConstraintSql.sql.includes("'pending_admin'")) {
  db.exec(`
    CREATE TABLE shop_orders_new (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      item_id INTEGER NOT NULL REFERENCES shop_items(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      total_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_admin' CHECK(status IN ('pending_admin','pending_superadmin','to_ship','to_receive','received','rejected','cancelled')),
      recipient_name TEXT,
      recipient_email TEXT,
      recipient_phone TEXT,
      shipping_address TEXT,
      id_photo TEXT,
      admin_approved_by INTEGER,
      super_admin_approved_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO shop_orders_new (id, user_id, item_id, quantity, total_price, status, recipient_name, recipient_email, recipient_phone, shipping_address, id_photo, admin_approved_by, super_admin_approved_by, created_at, updated_at)
    SELECT id, user_id, item_id, quantity, total_price,
      CASE status WHEN 'pending' THEN 'to_ship' WHEN 'fulfilled' THEN 'received' ELSE 'cancelled' END,
      recipient_name, recipient_email, recipient_phone, shipping_address, id_photo, admin_approved_by, super_admin_approved_by, created_at, updated_at
    FROM shop_orders;
    DROP TABLE shop_orders;
    ALTER TABLE shop_orders_new RENAME TO shop_orders;
  `);
}

// SQLite can't ALTER a CHECK constraint directly — if this database was
// created before 'premium' tier existed, rebuild the table with the wider
// constraint (standard SQLite migration pattern: new table -> copy -> swap).
const tierConstraintSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ticket_inventory'").get();
if (tierConstraintSql && tierConstraintSql.sql && !tierConstraintSql.sql.includes("'premium'")) {
  db.exec(`
    CREATE TABLE ticket_inventory_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL DEFAULT 'normal' CHECK(tier IN ('normal','gold','premium')),
      price REAL NOT NULL DEFAULT 0,
      qr_image TEXT,
      status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('pending_approval','approved','rejected','deployed','sold')),
      owner_user_id INTEGER REFERENCES users(id),
      dropped_into_draw_id INTEGER REFERENCES draws(id),
      pool_result TEXT CHECK(pool_result IS NULL OR pool_result IN ('won','lost')),
      pool_rank INTEGER,
      deploy_destination TEXT,
      created_by INTEGER,
      approved_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO ticket_inventory_new (id, ticket_code, tier, price, qr_image, status, owner_user_id, dropped_into_draw_id, pool_result, pool_rank, deploy_destination, created_by, approved_by, created_at, updated_at)
    SELECT id, ticket_code, tier, price, qr_image, status, owner_user_id, dropped_into_draw_id, pool_result, pool_rank, deploy_destination, created_by, approved_by, created_at, updated_at FROM ticket_inventory;
    DROP TABLE ticket_inventory;
    ALTER TABLE ticket_inventory_new RENAME TO ticket_inventory;
  `);
}
if (!ticketInventoryColumns.includes('pool_winner_status')) db.exec("ALTER TABLE ticket_inventory ADD COLUMN pool_winner_status TEXT NOT NULL DEFAULT 'pending'");
if (!ticketInventoryColumns.includes('pool_winner_amount')) db.exec("ALTER TABLE ticket_inventory ADD COLUMN pool_winner_amount REAL");

const announcementsColumns = db.prepare("PRAGMA table_info(announcements)").all().map(c => c.name);
if (!announcementsColumns.includes('media_url')) db.exec("ALTER TABLE announcements ADD COLUMN media_url TEXT");
if (!announcementsColumns.includes('media_type')) db.exec("ALTER TABLE announcements ADD COLUMN media_type TEXT");

db.exec(`
CREATE TABLE IF NOT EXISTS ban_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  ban_type TEXT NOT NULL DEFAULT 'permanent' CHECK(ban_type IN ('permanent','temporary','event')),
  duration_hours INTEGER,
  ban_ends_at TEXT,
  event_name TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Migration: add columns for databases that already had ban_requests
// created before the specific-datetime countdown feature existed.
const banRequestsColumns = db.prepare("PRAGMA table_info(ban_requests)").all().map(c => c.name);
if (!banRequestsColumns.includes('ban_ends_at')) db.exec("ALTER TABLE ban_requests ADD COLUMN ban_ends_at TEXT");

// Per-admin management preferences. Every change is also written to
// audit_log so Super Admin can always see what each Admin has changed.
db.exec(`
CREATE TABLE IF NOT EXISTS admin_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  default_user_sort TEXT NOT NULL DEFAULT 'newest',
  users_per_page INTEGER NOT NULL DEFAULT 25,
  notify_new_ban_requests INTEGER NOT NULL DEFAULT 1,
  notify_new_messages INTEGER NOT NULL DEFAULT 1,
  auto_refresh_seconds INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Personal preferences for regular users. Purely cosmetic/self-serve, but
// every change is logged to audit_log so Super Admin retains visibility.
db.exec(`
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  notify_new_messages INTEGER NOT NULL DEFAULT 1,
  notify_transaction_updates INTEGER NOT NULL DEFAULT 1,
  notify_draw_results INTEGER NOT NULL DEFAULT 1,
  default_dashboard_view TEXT NOT NULL DEFAULT 'summary',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Additional consolation-tier winners (rank 4+) for a draw, beyond the
// 1st/2nd/3rd (Gold/Silver/Bronze) columns stored directly on draws.
db.exec(`
CREATE TABLE IF NOT EXISTS draw_winners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_id INTEGER NOT NULL REFERENCES draws(id),
  ticket_number TEXT NOT NULL,
  rank INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Special items Admin/Super Admin deploy for live bidding. current_price
// starts at starting_price and rises with every bid; current_bidder_id is
// whoever is winning right now. Nothing is deducted from anyone's balance
// until the auction actually ends and a winner is settled.
db.exec(`
CREATE TABLE IF NOT EXISTS auction_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  image TEXT,
  starting_price REAL NOT NULL,
  current_price REAL NOT NULL,
  current_bidder_id INTEGER REFERENCES users(id),
  min_increment REAL NOT NULL DEFAULT 1,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','cancelled')),
  winner_user_id INTEGER REFERENCES users(id),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS auction_bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_item_id INTEGER NOT NULL REFERENCES auction_items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Admin cannot delete a user outright — they submit a request that Super
// Admin must approve or reject first, same pattern as ban_requests.
db.exec(`
CREATE TABLE IF NOT EXISTS user_delete_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at TEXT
);
`);

// Per-user personal preferences (their own device/notification settings
// only — never anything that affects other users). Every change is also
// written to audit_log so Super Admin always has visibility.
// (A duplicate user_settings CREATE TABLE used to be here — removed, since
// the earlier definition above is the one actually in effect: CREATE TABLE
// IF NOT EXISTS is a no-op once the table already exists.)

// Single-row table: which visual "engine" is shown for the live draw, and
// when the next auto-draw should trigger. Both Admin and Super Admin can
// edit this; whatever is selected here is exactly what users see on Live Draw.
db.exec(`
CREATE TABLE IF NOT EXISTS draw_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_engine TEXT NOT NULL DEFAULT 'wheel' CHECK(active_engine IN ('wheel','tambiolo','dice','cards')),
  target_datetime TEXT,
  ticket_threshold INTEGER,
  winner_count INTEGER NOT NULL DEFAULT 1,
  schedule_verified_by INTEGER,
  schedule_verified_at TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO draw_settings (id) VALUES (1);
`);

// Migration: add verification columns for databases that already had
// draw_settings created before this feature existed.
const drawSettingsColumns = db.prepare("PRAGMA table_info(draw_settings)").all().map(c => c.name);
if (!drawSettingsColumns.includes('schedule_verified_by')) db.exec("ALTER TABLE draw_settings ADD COLUMN schedule_verified_by INTEGER");
if (!drawSettingsColumns.includes('schedule_verified_at')) db.exec("ALTER TABLE draw_settings ADD COLUMN schedule_verified_at TEXT");
if (!drawSettingsColumns.includes('winner_count')) db.exec("ALTER TABLE draw_settings ADD COLUMN winner_count INTEGER NOT NULL DEFAULT 1");

// Uploaded sound files (background music/effects) that Admin/Super Admin
// can deploy to specific pages (e.g. Live Draw, Shop).
db.exec(`
CREATE TABLE IF NOT EXISTS audio_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Which audio file (if any) is currently assigned as the background sound
// for a given page. page_key is a fixed string like 'live_draw' or 'shop'.
db.exec(`
CREATE TABLE IF NOT EXISTS audio_deployments (
  page_key TEXT PRIMARY KEY,
  audio_file_id INTEGER REFERENCES audio_files(id),
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Shard Collection Event — Admin/Super Admin turns an event "on", and while
// it's active, every user can collect a random amount of shards once per
// day. Shards accumulate in the user's Inventory.
db.exec(`
CREATE TABLE IF NOT EXISTS shard_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  icon_type TEXT NOT NULL DEFAULT 'shard',
  end_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Migration: add columns for databases that already had shard_events
// created before icon selection and duration existed.
const shardEventsColumns = db.prepare("PRAGMA table_info(shard_events)").all().map(c => c.name);
if (!shardEventsColumns.includes('icon_type')) db.exec("ALTER TABLE shard_events ADD COLUMN icon_type TEXT NOT NULL DEFAULT 'shard'");
if (!shardEventsColumns.includes('end_date')) db.exec("ALTER TABLE shard_events ADD COLUMN end_date TEXT");
if (!shardEventsColumns.includes('photo')) db.exec("ALTER TABLE shard_events ADD COLUMN photo TEXT");

// Rebuild shard_events if it still carries the old single-icon CHECK
// constraint — icon_type now stores a comma-separated list so staff can
// select multiple icon types for one event (users get a random one per collect).
const shardEventsConstraintSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shard_events'").get();
if (shardEventsConstraintSql && shardEventsConstraintSql.sql && shardEventsConstraintSql.sql.includes("CHECK(icon_type")) {
  db.exec(`
    CREATE TABLE shard_events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      icon_type TEXT NOT NULL DEFAULT 'shard',
      end_date TEXT,
      photo TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO shard_events_new (id, name, description, icon_type, end_date, photo, is_active, created_by, created_at)
    SELECT id, name, description, icon_type, end_date, photo, is_active, created_by, created_at FROM shard_events;
    DROP TABLE shard_events;
    ALTER TABLE shard_events_new RENAME TO shard_events;
  `);
}

// One row per user per day they collected — also doubles as the running
// ledger for their total (SUM(amount)).
db.exec(`
CREATE TABLE IF NOT EXISTS shard_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shard_event_id INTEGER NOT NULL REFERENCES shard_events(id),
  amount INTEGER NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'shard',
  collected_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, shard_event_id, collected_date)
);
`);

// Migration: add item_type for databases that had shard_collections before
// multi-icon events existed.
const shardCollectionsColumns2 = db.prepare("PRAGMA table_info(shard_collections)").all().map(c => c.name);
if (!shardCollectionsColumns2.includes('item_type')) db.exec("ALTER TABLE shard_collections ADD COLUMN item_type TEXT NOT NULL DEFAULT 'shard'");

// Per-category retention period (in days) for uploaded files, managed
// exclusively by Super Admin from Settings > File Storage. NULL/0 means
// "keep forever" (no auto-cleanup) for that category.
db.exec(`
CREATE TABLE IF NOT EXISTS storage_retention_settings (
  category TEXT PRIMARY KEY,
  retention_days INTEGER,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Tracks when each staff member last opened each conversation, so the
// unread red-dot clears the moment they actually view it — not only when
// they send a reply.
db.exec(`
CREATE TABLE IF NOT EXISTS message_read_status (
  staff_user_id INTEGER NOT NULL,
  thread_user_id INTEGER NOT NULL,
  last_read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (staff_user_id, thread_user_id)
);
`);

// Simple key-value store for platform-wide settings Super Admin can tune,
// starting with the deposit/withdrawal service fee percentage.
db.exec(`
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// Human-readable reference IDs and fee breakdown for deposits/withdrawals —
// lets staff instantly tell requests apart during approval, and lets users
// see exactly what was charged on their digital receipt.
const depositColumns = db.prepare("PRAGMA table_info(deposit_requests)").all().map(c => c.name);
if (!depositColumns.includes('display_id')) db.exec("ALTER TABLE deposit_requests ADD COLUMN display_id TEXT");
if (!depositColumns.includes('fee_amount')) db.exec("ALTER TABLE deposit_requests ADD COLUMN fee_amount REAL NOT NULL DEFAULT 0");
if (!depositColumns.includes('net_amount')) db.exec("ALTER TABLE deposit_requests ADD COLUMN net_amount REAL");

const withdrawalColumns2 = db.prepare("PRAGMA table_info(withdrawal_requests)").all().map(c => c.name);
if (!withdrawalColumns2.includes('display_id')) db.exec("ALTER TABLE withdrawal_requests ADD COLUMN display_id TEXT");
if (!withdrawalColumns2.includes('fee_amount')) db.exec("ALTER TABLE withdrawal_requests ADD COLUMN fee_amount REAL NOT NULL DEFAULT 0");
if (!withdrawalColumns2.includes('net_amount')) db.exec("ALTER TABLE withdrawal_requests ADD COLUMN net_amount REAL");

// ---------------- Performance indexes ----------------
// SQLite auto-indexes PRIMARY KEY columns, but every other column used in
// WHERE/ORDER BY across the app's frequent queries was doing a full table
// scan. These cover the hot paths: login lookups, "my transactions/tickets/
// orders" listings, and staff review queues filtered by status.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_deposit_requests_user_id ON deposit_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_deposit_requests_status ON deposit_requests(status);
  CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_id ON withdrawal_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
  CREATE INDEX IF NOT EXISTS idx_shop_orders_user_id ON shop_orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_draw_id ON tickets(draw_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);
  CREATE INDEX IF NOT EXISTS idx_ticket_inventory_owner_user_id ON ticket_inventory(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_ticket_inventory_status ON ticket_inventory(status);
  CREATE INDEX IF NOT EXISTS idx_ticket_inventory_dropped_into_draw_id ON ticket_inventory(dropped_into_draw_id);
  CREATE INDEX IF NOT EXISTS idx_messages_thread_user_id ON messages(thread_user_id);
  CREATE INDEX IF NOT EXISTS idx_auction_items_status ON auction_items(status);
  CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_item_id ON auction_bids(auction_item_id);
  CREATE INDEX IF NOT EXISTS idx_ban_requests_status ON ban_requests(status);
  CREATE INDEX IF NOT EXISTS idx_draw_winners_draw_id ON draw_winners(draw_id);
`);

module.exports = db;
