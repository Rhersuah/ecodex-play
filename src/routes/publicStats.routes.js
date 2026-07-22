const express = require('express');
const db = require('../db');

const router = express.Router();

// PUBLIC endpoint — no login required. Shows real, live numbers on the
// sign-in page instead of a hardcoded placeholder ("8K+ Registered
// Players"). These counts are genuine — no inflation, no fake numbers.
router.get('/', (req, res) => {
  // Rejected signups (flagged anomalies, duplicate-IP attempts, etc.) never
  // counted as real registered players.
  const registeredPlayers = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'user' AND approval_status != 'rejected'").get().c;

  // "Prizes awarded" = every raffle ticket (old system) or pool ticket
  // (ECP system) that has actually won a draw.
  const raffleWins = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status = 'won'").get().c;
  const poolWins = db.prepare("SELECT COUNT(*) c FROM ticket_inventory WHERE pool_result = 'won'").get().c;
  const prizesAwarded = raffleWins + poolWins;

  res.json({ registeredPlayers, prizesAwarded });
});

module.exports = router;
