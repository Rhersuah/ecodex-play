// VIP tiers — Roman numerals I through X, reached by earning Points
// through platform activity (never bought outright with cash). Point
// thresholds are ascending; Super Admin can tune how fast points are
// earned, but these tier thresholds are the fixed ladder everyone climbs.
const VIP_TIERS = [
  { tier: 1, roman: 'I', pointsRequired: 100 },
  { tier: 2, roman: 'II', pointsRequired: 250 },
  { tier: 3, roman: 'III', pointsRequired: 500 },
  { tier: 4, roman: 'IV', pointsRequired: 1000 },
  { tier: 5, roman: 'V', pointsRequired: 2000 },
  { tier: 6, roman: 'VI', pointsRequired: 4000 },
  { tier: 7, roman: 'VII', pointsRequired: 7000 },
  { tier: 8, roman: 'VIII', pointsRequired: 12000 },
  { tier: 9, roman: 'IX', pointsRequired: 20000 },
  { tier: 10, roman: 'X', pointsRequired: 35000 },
];

function getTierByLevel(tier) {
  return VIP_TIERS.find(t => t.tier === tier) || null;
}

// Given a total points balance, returns the highest VIP tier reached (or
// null if below the first tier).
function tierForPoints(points) {
  return [...VIP_TIERS].reverse().find(t => points >= t.pointsRequired) || null;
}

module.exports = { VIP_TIERS, getTierByLevel, tierForPoints };
