'use strict';

/**
 * oddspapiCricketCatalog.js
 *
 * Verified market catalog and accuracy helpers for Oddspapi v5 Cricket (`sportId: 27`).
 * Market ID ranges verified directly against `https://v5.oddspapi.io/en/markets?sportId=27`.
 */

const SIDE_AND_PROP_MARKET_IDS = new Set([
  276,     // Tied Match
  278,     // To Win the Coin Toss
  2710,    // Completed Match
  2724029, // Odd Even First Over
  2724031, // First Wicket Method
  2724037, // First Wicket Method Caught
  2724039, // First Wicket Fall
  2724121, // Highest Individual Scores
  2738327, // Odd Even First Innings
  2738329, // Odd Even Second Innings
]);

/**
 * Exact Oddspapi v5 market ID ranges for cricket innings & overs line markets:
 *   [overs (0 = full innings), innings (1|2), minMarketId, maxMarketId, teamSlot (0=match, 1=team1, 2=team2)]
 */
const OVER_LINE_RANGES = [
  // Full innings runs line
  [0, 1, 27160, 27760, 0],
  [0, 2, 27762, 271362, 0],
  [0, 1, 2729523, 2730223, 1],
  [0, 2, 2730225, 2730925, 2],

  // 1st & 2nd Innings N Overs Line (Overs 1..20)
  [1,  1, 271364,  271434,  0], [1,  2, 271436,  271506,  0],
  [2,  1, 271508,  271650,  0], [2,  2, 271652,  271794,  0],
  [3,  1, 271796,  272010,  0], [3,  2, 272012,  272226,  0],
  [4,  1, 272228,  272514,  0], [4,  2, 272516,  272802,  0],
  [5,  1, 272804,  273162,  0], [5,  2, 273164,  273522,  0],
  [6,  1, 273524,  273954,  0], [6,  2, 273956,  274386,  0],
  [7,  1, 274388,  274890,  0], [7,  2, 274892,  275394,  0],
  [8,  1, 275396,  275970,  0], [8,  2, 275972,  276546,  0],
  [9,  1, 276548,  277248,  0], [9,  2, 277250,  277950,  0],
  [10, 1, 277952,  278652,  0], [10, 2, 278654,  279354,  0],
  [11, 1, 279356,  2710056, 0], [11, 2, 2710058, 2710758, 0],
  [12, 1, 2710760, 2711460, 0], [12, 2, 2711462, 2712162, 0],
  [13, 1, 2712164, 2712864, 0], [13, 2, 2712866, 2713566, 0],
  [14, 1, 2713568, 2714268, 0], [14, 2, 2714270, 2714970, 0],
  [15, 1, 2714972, 2715672, 0], [15, 2, 2715674, 2716374, 0],
  [16, 1, 2716376, 2717076, 0], [16, 2, 2717078, 2717778, 0],
  [17, 1, 2717780, 2718480, 0], [17, 2, 2718482, 2719182, 0],
  [18, 1, 2719184, 2719884, 0], [18, 2, 2719886, 2720586, 0],
  [19, 1, 2720588, 2721288, 0], [19, 2, 2721290, 2721990, 0],
  [20, 1, 2721992, 2722692, 0], [20, 2, 2722694, 2723394, 0],

  // First Innings Team 1 & Team 2 Overs Line (Overs 1..20)
  [1,  1, 2724483, 2724493, 1], [1,  1, 2724495, 2724505, 2],
  [2,  1, 2724507, 2724529, 1], [2,  1, 2724531, 2724553, 2],
  [3,  1, 2724555, 2724589, 1], [3,  1, 2724591, 2724625, 2],
  [4,  1, 2724627, 2724673, 1], [4,  1, 2724675, 2724721, 2],
  [5,  1, 2724723, 2724781, 1], [5,  1, 2724783, 2724841, 2],
  [6,  1, 2724843, 2724913, 1], [6,  1, 2724915, 2724985, 2],
  [7,  1, 2724987, 2725069, 1], [7,  1, 2725071, 2725153, 2],
  [8,  1, 2725155, 2725249, 1], [8,  1, 2725251, 2725345, 2],
  [9,  1, 2725347, 2725453, 1], [9,  1, 2725455, 2725561, 2],
  [10, 1, 2725563, 2725681, 1], [10, 1, 2725683, 2725801, 2],
  [11, 1, 2725803, 2725933, 1], [11, 1, 2725935, 2726065, 2],
  [12, 1, 2726067, 2726209, 1], [12, 1, 2726211, 2726353, 2],
  [13, 1, 2726355, 2726509, 1], [13, 1, 2726511, 2726665, 2],
  [14, 1, 2726667, 2726833, 1], [14, 1, 2726835, 2727001, 2],
  [15, 1, 2727003, 2727181, 1], [15, 1, 2727183, 2727361, 2],
  [16, 1, 2727363, 2727553, 1], [16, 1, 2727555, 2727745, 2],
  [17, 1, 2727747, 2727949, 1], [17, 1, 2727951, 2728153, 2],
  [18, 1, 2728155, 2728369, 1], [18, 1, 2728371, 2728585, 2],
  [19, 1, 2728587, 2728813, 1], [19, 1, 2728815, 2729041, 2],
  [20, 1, 2729043, 2729281, 1], [20, 1, 2729283, 2729521, 2],
];

function ordinal(n) {
  return n === 1 ? '1st' : '2nd';
}

/**
 * Resolves Oddspapi quote / market metadata into a Betfair Fancy descriptor if applicable.
 * Returns `{ key, name, innings, overN, teamSlot }` or `null`.
 */
function resolveBetfairFancyMeta(quote, match = {}) {
  if (!quote) return null;
  const mId = Number(quote.marketId);
  const teamA = String(match?.teamA || 'Team 1').trim();
  const teamB = String(match?.teamB || 'Team 2').trim();

  // Exclude known non-fancy side/prop/delivery markets
  if (Number.isFinite(mId)) {
    if (mId === 271 || mId === 273 || SIDE_AND_PROP_MARKET_IDS.has(mId)) return null;
    if (mId >= 2730927 && mId <= 2738330) return null; // Delivery ball markets & player props
    if (mId >= 2723403 && mId <= 2724121) return null; // Top batter/bowler, player runs, odd/even 1st over
  }

  // 1. Exact numeric Oddspapi marketId range lookup
  if (Number.isFinite(mId)) {
    for (const [overN, innings, minId, maxId, teamSlot] of OVER_LINE_RANGES) {
      if (mId >= minId && mId <= maxId) {
        if (overN === 0) {
          if (teamSlot === 1) {
            return {
              key: `runs_t1_${innings}`,
              name: `${teamA} Innings Runs Line`,
              innings,
              overN: 0,
              teamSlot,
            };
          }
          if (teamSlot === 2) {
            return {
              key: `runs_t2_${innings}`,
              name: `${teamB} Innings Runs Line`,
              innings,
              overN: 0,
              teamSlot,
            };
          }
          return {
            key: `runs_inn_${innings}`,
            name: `${ordinal(innings)} Innings Runs Line`,
            innings,
            overN: 0,
            teamSlot: 0,
          };
        }
        const overLabel = overN === 1 ? '1 Over' : `${overN} Overs`;
        if (teamSlot === 1) {
          return {
            key: `over_t1_${innings}_${overN}`,
            name: `${teamA} ${overLabel} Line`,
            innings,
            overN,
            teamSlot,
          };
        }
        if (teamSlot === 2) {
          return {
            key: `over_t2_${innings}_${overN}`,
            name: `${teamB} ${overLabel} Line`,
            innings,
            overN,
            teamSlot,
          };
        }
        return {
          key: `over_inn_${innings}_${overN}`,
          name: `${ordinal(innings)} Innings ${overLabel} Line`,
          innings,
          overN,
          teamSlot: 0,
        };
      }
    }
  }

  // 2. Fallback text matching for named Betfair Line / Session quotes
  const rawName = String(quote.marketName || quote.name || quote.marketType || '').trim();
  if (!rawName) return null;
  const lower = rawName.toLowerCase();
  if (
    lower.includes('delivery') ||
    lower.includes('ball') ||
    lower.includes('odd') ||
    lower.includes('even') ||
    lower.includes('coin toss') ||
    lower.includes('tied match') ||
    lower.includes('completed match') ||
    lower.includes('fours') ||
    lower.includes('sixes') ||
    lower.includes('wicket') ||
    lower.includes('player')
  ) {
    return null;
  }

  // e.g. "2nd Innings 6 Overs Line" or "6 Overs Second Innings"
  const oversInningsMatch =
    rawName.match(/(1st|2nd|first|second)\s*Innings?\s*(\d+)\s*Overs?/i) ||
    rawName.match(/(\d+)\s*Overs?\s*(First|Second|1st|2nd)\s*Innings?/i);
  if (oversInningsMatch) {
    const a = oversInningsMatch[1];
    const b = oversInningsMatch[2];
    const isFirstFirst = /^(1st|first|2nd|second)$/i.test(a);
    const inn = /second|2nd/i.test(isFirstFirst ? a : b) ? 2 : 1;
    const overN = parseInt(isFirstFirst ? b : a, 10);
    const overLabel = overN === 1 ? '1 Over' : `${overN} Overs`;
    return {
      key: `over_inn_${inn}_${overN}`,
      name: `${ordinal(inn)} Innings ${overLabel} Line`,
      innings: inn,
      overN,
      teamSlot: 0,
    };
  }

  if (/over\s*under\s*runs\s*(first|1st|second|2nd)\s*innings/i.test(rawName)) {
    const inn = /second|2nd/i.test(rawName) ? 2 : 1;
    return {
      key: `runs_inn_${inn}`,
      name: `${ordinal(inningsWordToNum(inn))} Innings Runs Line`,
      innings: inn,
      overN: 0,
      teamSlot: 0,
    };
  }

  if (/\binnings\b.*\bline\b|\bovers?\b.*\bline\b/i.test(rawName)) {
    return {
      key: `custom_${rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      name: rawName,
      innings: /2nd|second/i.test(rawName) ? 2 : 1,
      overN: 0,
      teamSlot: 0,
    };
  }

  return null;
}

function inningsWordToNum(n) {
  return n === 2 ? 2 : 1;
}

function isNonMatchOddsMarket(marketId, grp = []) {
  const mId = Number(marketId);
  if (Number.isFinite(mId)) {
    if (SIDE_AND_PROP_MARKET_IDS.has(mId)) return true;
    if (mId >= 2712 && mId <= 2738330) return true; // Fours, sixes, overs, runs, deliveries, props, oddeven
  }
  const sample = grp[0];
  if (!sample) return false;
  const mt = String(sample.marketType || sample.marketName || '').toLowerCase();
  if (
    mt.includes('tied') ||
    mt.includes('toss') ||
    mt.includes('completed') ||
    mt.includes('oddeven') ||
    mt.includes('total') ||
    mt.includes('overs') ||
    mt.includes('innings')
  ) {
    return true;
  }
  if (resolveBetfairFancyMeta(sample) !== null) return true;
  return false;
}

function isDrawOutcome(q) {
  if (!q) return false;
  const name = String(q.outcomeName || q.name || q.label || '').trim().toLowerCase();
  return q.outcomeId === 274 || name === 'x' || name === 'the draw' || name === 'draw' || name === 'tie';
}

/**
 * Selects the most accurate Match Odds market group from Oddspapi quotes.
 *
 * Key Oddspapi fix:
 * - For limited-overs matches (T10 / T20 / ODI), market `271` ("Winner (incl. super over)")
 *   is the main high-liquidity Betfair Match Odds market. Market `273` ("1X2") has 3 outcomes
 *   with near-zero liquidity and wider spreads, so `271` MUST take priority for non-Test matches.
 * - For Test / First-Class matches, market `273` ("1X2" with Draw outcome `274`) takes priority.
 */
function selectAccurateMatchOddsMarket(byMarket, isTestMatch = false) {
  if (!byMarket || typeof byMarket !== 'object') return null;

  if (isTestMatch) {
    if (byMarket['273'] && byMarket['273'].length >= 2) {
      return byMarket['273'];
    }
    for (const [mId, grp] of Object.entries(byMarket)) {
      if (isNonMatchOddsMarket(mId, grp)) continue;
      if (grp.length === 3 || grp.some(isDrawOutcome)) {
        return grp;
      }
    }
    if (byMarket['271'] && byMarket['271'].length >= 2) {
      return byMarket['271'];
    }
  } else {
    // Non-Test (T10, T20, ODI): Winner (271) is the canonical Betfair Match Odds market
    if (byMarket['271'] && byMarket['271'].length >= 2) {
      return byMarket['271'];
    }
    // Check explicit 2-way mainLine excluding 273 / side markets
    for (const [mId, grp] of Object.entries(byMarket)) {
      if (mId === '273' || isNonMatchOddsMarket(mId, grp)) continue;
      if (grp.length === 2 && grp.some((q) => q.mainLine === true)) {
        return grp;
      }
    }
    // Fallback to any non-side mainLine or 273
    for (const [mId, grp] of Object.entries(byMarket)) {
      if (isNonMatchOddsMarket(mId, grp)) continue;
      if ((grp.length === 2 || grp.length === 3) && (grp.some((q) => q.mainLine === true) || mId === 'default')) {
        return grp;
      }
    }
    if (byMarket['273'] && byMarket['273'].length >= 2) {
      return byMarket['273'];
    }
  }

  for (const [mId, grp] of Object.entries(byMarket)) {
    if (isNonMatchOddsMarket(mId, grp)) continue;
    if (grp.length === 2 || grp.length === 3) {
      return grp;
    }
  }

  return null;
}

function formatLiquidityVolume(val, fallback = '100') {
  if (val === null || val === undefined || val === '' || isNaN(Number(val))) return String(fallback);
  const num = Number(val);
  if (num <= 0) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (num < 1) return '1';
  return String(Math.round(num));
}

/**
 * Extracts accurate best back/lay and up-to-3 ladder levels from an Oddspapi outcome quote.
 */
function extractRunnerDepthFromQuote(quote, isExchange = true, defaultVol = '100') {
  if (!quote) {
    return { back: 0, backVol: '0', lay: 0, layVol: '0', backOdds: [], layOdds: [] };
  }

  if (isExchange && quote.meta) {
    const rawBacks = Array.isArray(quote.meta.availableToBack) ? quote.meta.availableToBack : [];
    const rawLays = Array.isArray(quote.meta.availableToLay) ? quote.meta.availableToLay : [];

    const backOdds = rawBacks
      .filter((b) => b && Number(b.price) > 0)
      .slice(0, 3)
      .map((b) => ({
        price: Number(b.price),
        volume: formatLiquidityVolume(b.size, defaultVol),
      }));

    const layOdds = rawLays
      .filter((l) => l && Number(l.price) > 0)
      .slice(0, 3)
      .map((l) => ({
        price: Number(l.price),
        volume: formatLiquidityVolume(l.size, defaultVol),
      }));

    const bestBack = backOdds[0]?.price || (quote.price ? Number(quote.price) : 0);
    const bestBackVol =
      backOdds[0]?.volume ||
      (quote.limit !== undefined ? formatLiquidityVolume(quote.limit, defaultVol) : defaultVol);
    const bestLay =
      layOdds[0]?.price ||
      (bestBack > 0 ? Number((bestBack + 0.02).toFixed(2)) : 0);
    const bestLayVol = layOdds[0]?.volume || defaultVol;

    if (backOdds.length === 0 && bestBack > 0) {
      backOdds.push({ price: bestBack, volume: bestBackVol });
    }
    if (layOdds.length === 0 && bestLay > 0) {
      layOdds.push({ price: bestLay, volume: bestLayVol });
    }

    return {
      back: bestBack,
      backVol: bestBackVol,
      lay: bestLay,
      layVol: bestLayVol,
      backOdds,
      layOdds,
    };
  }

  const price = quote.price ? Number(quote.price) : 0;
  const vol = quote.limit !== undefined ? formatLiquidityVolume(quote.limit, '500') : '500';
  const lay = price > 0 ? Number((price + 0.01).toFixed(2)) : 0;
  return {
    back: price,
    backVol: vol,
    lay,
    layVol: '500',
    backOdds: price > 0 ? [{ price, volume: vol }] : [],
    layOdds: lay > 0 ? [{ price: lay, volume: '500' }] : [],
  };
}

module.exports = {
  SIDE_AND_PROP_MARKET_IDS,
  OVER_LINE_RANGES,
  resolveBetfairFancyMeta,
  isNonMatchOddsMarket,
  selectAccurateMatchOddsMarket,
  formatLiquidityVolume,
  extractRunnerDepthFromQuote,
};
