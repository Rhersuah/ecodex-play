const { tierForPoints } = require('./vipTiers');

// Default points earned per ₱100 spent/deposited, for each activity type.
// Super Admin can override these via platform_settings — deposits earn
// noticeably less than actually playing (tickets/shop/auction), since the
// goal is to reward engagement, not just parking money in the wallet.
const DEFAULT_RATES = {
  deposit: 1,
  ticket: 5,
  shop: 5,
  auction: 5,
};

function getPointsRates(db) {
  const rows = db.prepare("SELECT key, value FROM platform_settings WHERE key LIKE 'points_rate_%'").all();
  const rates = { ...DEFAULT_RATES };
  rows.forEach((r) => {
    const category = r.key.replace('points_rate_', '');
    const parsed = parseFloat(r.value);
    if (category in rates && !Number.isNaN(parsed)) rates[category] = parsed;
  });
  return rates;
}

// Awards points for a peso amount spent/deposited in a given category, and
// auto-upgrades the user's VIP tier if their new total crosses a threshold
// (tiers never go down).
function awardPoints(db, userId, category, pesoAmount) {
  const rates = getPointsRates(db);
  const rate = rates[category] != null ? rates[category] : 0;
  const earned = Math.round((pesoAmount / 100) * rate * 100) / 100;
  if (!earned || earned <= 0 || Number.isNaN(earned)) return;

  db.prepare('UPDATE users SET total_points = total_points + ? WHERE id = ?').run(earned, userId);
  const user = db.prepare('SELECT total_points, vip_tier FROM users WHERE id = ?').get(userId);
  if (!user) return; // user vanished between the update and this read — nothing more to do
  const earnedTier = tierForPoints(user.total_points);
  if (earnedTier && earnedTier.tier > user.vip_tier) {
    db.prepare('UPDATE users SET vip_tier = ? WHERE id = ?').run(earnedTier.tier, userId);
  }
}

module.exports = { getPointsRates, awardPoints, DEFAULT_RATES };
