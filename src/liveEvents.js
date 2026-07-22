// ============================================================
// Real-time event broadcaster (Server-Sent Events)
// ------------------------------------------------------------
// Lets the backend push a lightweight "something changed" signal to every
// connected browser tab the instant it happens — no more waiting for the
// next 8-30 second poll, and no full page reload needed. The payload is
// intentionally small (just a category + optional role hint); the
// frontend reacts by silently re-running its own existing fetch/render
// function for that piece of data, the same one it already uses on a
// timer. This endpoint just tells it "now is a good time to do that
// early," rather than replacing the polling entirely (which stays as a
// safety net in case the SSE connection drops).
// ============================================================
const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(0); // unlimited concurrent connected clients

const clients = new Map(); // res -> role

function addClient(res, role) {
  clients.set(res, role);
}

function removeClient(res) {
  clients.delete(res);
}

// category examples: 'transactions', 'messages', 'accounts', 'tickets',
// 'orders', 'bans', 'auctions'. targetRoles narrows who should react
// (e.g. only admin/super_admin care about a new pending transaction) —
// omit or pass null to notify everyone connected.
function broadcast(category, targetRoles) {
  const payload = JSON.stringify({ category, targetRoles: targetRoles || null, at: new Date().toISOString() });
  for (const [res, role] of clients) {
    if (targetRoles && !targetRoles.includes(role)) continue;
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (e) {
      clients.delete(res);
    }
  }
}

module.exports = { addClient, removeClient, broadcast };
