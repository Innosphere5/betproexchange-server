'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Import helper logic or replicate module logic for thorough unit testing
function matchesTeamName(runnerStr, teamStr) {
  if (!runnerStr || !teamStr) return false;
  const r = runnerStr.trim().toLowerCase();
  const t = teamStr.trim().toLowerCase();
  return r === t || r.includes(t) || t.includes(r);
}

function getValidMarketOddsList(matchInDb, runner, betType, marketType) {
  const normRunner = String(runner || '').trim().toLowerCase();
  const type = (betType || 'back').toLowerCase();
  const mType = (marketType || 'match_odds').toLowerCase();

  // 1. Universal Toss Odds: strictly 1.98 for Back, 2.02 for Lay across all matches
  if (mType === 'toss') {
    return type === 'lay' ? [2.02] : [1.98];
  }

  const teamAName = String(matchInDb.teamA || '').trim();
  const teamBName = String(matchInDb.teamB || '').trim();
  const isTeamA = matchesTeamName(normRunner, teamAName);
  const isTeamB = matchesTeamName(normRunner, teamBName);

  // 2. Bookmaker Market
  if (mType === 'bookmaker') {
    if (isTeamA) {
      if (type === 'back') {
        const list = [];
        if (matchInDb.bookmakerBackA) list.push(Number(matchInDb.bookmakerBackA));
        if (matchInDb.backOddsA) list.push(Number(matchInDb.backOddsA));
        return list;
      } else {
        const list = [];
        if (matchInDb.bookmakerLayA) list.push(Number(matchInDb.bookmakerLayA));
        if (matchInDb.layOddsA) {
          list.push(Number(matchInDb.layOddsA));
          list.push(Number((matchInDb.layOddsA > (matchInDb.backOddsA || 0) ? matchInDb.layOddsA + 0.01 : (matchInDb.backOddsA || 0) + 0.02).toFixed(2)));
        }
        return list;
      }
    } else if (isTeamB) {
      if (type === 'back') {
        const list = [];
        if (matchInDb.bookmakerBackB) list.push(Number(matchInDb.bookmakerBackB));
        if (matchInDb.backOddsB) {
          list.push(Number(matchInDb.backOddsB));
          list.push(Number((matchInDb.backOddsB >= 2 ? matchInDb.backOddsB - 0.02 : matchInDb.backOddsB).toFixed(2)));
        }
        return list;
      } else {
        const list = [];
        if (matchInDb.bookmakerLayB) list.push(Number(matchInDb.bookmakerLayB));
        if (matchInDb.layOddsB) {
          list.push(Number(matchInDb.layOddsB));
          list.push(Number((matchInDb.layOddsB >= 2 ? matchInDb.layOddsB + 0.02 : matchInDb.layOddsB + 0.02).toFixed(2)));
        }
        return list;
      }
    }
    return [];
  }

  // 3. Figure Market
  if (mType === 'figure') {
    if (Array.isArray(matchInDb.figureMarkets)) {
      const digitMatch = normRunner.match(/digit\s*(\d+)/i);
      if (digitMatch) {
        const digitNum = parseInt(digitMatch[1], 10);
        for (const fig of matchInDb.figureMarkets) {
          const foundDigit = fig.digits?.find(d => d.digit === digitNum);
          if (foundDigit && foundDigit.odds) {
            return [Number(foundDigit.odds)];
          }
        }
      }
    }
    return [8.85];
  }

  // 4. Fancy Market
  if (mType === 'fancy') {
    if (Array.isArray(matchInDb.fancyMarkets)) {
      const item = matchInDb.fancyMarkets.find(f => normRunner.includes(String(f.name).toLowerCase()) || String(f.name).toLowerCase().includes(normRunner));
      if (item) {
        const p = type === 'lay' ? (item.layPrice || 1.95) : (item.backPrice || 1.95);
        return p ? [Number(p)] : [1.95];
      }
    }
    return [1.95];
  }

  // 5. Even / Odd Market
  if (mType === 'even_odd') {
    if (Array.isArray(matchInDb.evenOddMarkets)) {
      const item = matchInDb.evenOddMarkets.find(eo => normRunner.includes(String(eo.name).toLowerCase()) || String(eo.name).toLowerCase().includes(normRunner));
      if (item) {
        const p = type === 'lay' ? eo.layPrice : eo.backPrice;
        return p ? [Number(p)] : [];
      }
    }
    return [];
  }

  // 6. Tied Match Market
  if (mType === 'tied_match') {
    if (matchInDb.tiedMatchMarket?.runners) {
      const isYes = normRunner.includes('yes');
      const isNo = normRunner.includes('no');
      const runnerItem = matchInDb.tiedMatchMarket.runners.find(r => {
        const rName = String(r.name).toLowerCase();
        return (isYes && rName === 'yes') || (isNo && rName === 'no');
      });
      if (runnerItem) {
        const oddsList = type === 'back' ? (runnerItem.backOdds || []) : (runnerItem.layOdds || []);
        return oddsList.map(o => Number(o.price)).filter(p => !isNaN(p) && p > 0);
      }
    }
    return [];
  }

  // 7. Match Odds (standard)
  if (isTeamA) {
    const val = type === 'back' ? matchInDb.backOddsA : matchInDb.layOddsA;
    return val ? [Number(val)] : [];
  } else if (isTeamB) {
    const val = type === 'back' ? matchInDb.backOddsB : matchInDb.layOddsB;
    return val ? [Number(val)] : [];
  }

  return [];
}

function validateBetOdds(matchInDb, runner, betOdds, betType, marketType) {
  const numOdds = parseFloat(betOdds);
  if (!numOdds || isNaN(numOdds) || numOdds <= 1) {
    return { valid: false, error: 'Bet not placed to this market' };
  }
  const validOdds = getValidMarketOddsList(matchInDb, runner, betType, marketType);
  const matchesExpected = validOdds.some(expected => Math.abs(numOdds - expected) <= 0.001);
  if (!matchesExpected) {
    return { valid: false, error: 'Bet not placed to this market' };
  }
  return { valid: true };
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

test('Universal Toss Odds: 1.98 back and 2.02 lay for any match', () => {
  const dummyMatch = { teamA: 'India', teamB: 'Australia', status: 'upcoming' };
  
  // Team A Toss Back
  const backA = validateBetOdds(dummyMatch, 'India To Win The Toss', 1.98, 'back', 'toss');
  assert.equal(backA.valid, true);

  // Team A Toss Lay
  const layA = validateBetOdds(dummyMatch, 'India To Win The Toss', 2.02, 'lay', 'toss');
  assert.equal(layA.valid, true);

  // Team B Toss Back
  const backB = validateBetOdds(dummyMatch, 'Australia To Win The Toss', 1.98, 'back', 'toss');
  assert.equal(backB.valid, true);

  // Team B Toss Lay
  const layB = validateBetOdds(dummyMatch, 'Australia To Win The Toss', 2.02, 'lay', 'toss');
  assert.equal(layB.valid, true);
});

test('Toss: Reject if user edits odds to 1.99 or 99', () => {
  const dummyMatch = { teamA: 'India', teamB: 'Australia', status: 'upcoming' };
  
  const res1 = validateBetOdds(dummyMatch, 'India To Win The Toss', 1.99, 'back', 'toss');
  assert.equal(res1.valid, false);
  assert.equal(res1.error, 'Bet not placed to this market');

  const res2 = validateBetOdds(dummyMatch, 'India To Win The Toss', 99, 'back', 'toss');
  assert.equal(res2.valid, false);
  assert.equal(res2.error, 'Bet not placed to this market');
});

test('Match Odds: user bets at shown odds (1.76, 2.08) -> SUCCESS', () => {
  const sampleMatch = {
    teamA: 'India Legends',
    teamB: 'South Africa Legends',
    backOddsA: 1.76,
    layOddsA: 1.78,
    backOddsB: 2.08,
    layOddsB: 2.12
  };

  // Back India Legends @1.76
  const b1 = validateBetOdds(sampleMatch, 'India Legends', 1.76, 'back', 'match_odds');
  assert.equal(b1.valid, true);

  // Back SA Legends @2.08
  const b2 = validateBetOdds(sampleMatch, 'South Africa Legends', 2.08, 'back', 'match_odds');
  assert.equal(b2.valid, true);
});

test('Match Odds: user edits odds from 1.76 to 1.98 or 99 -> REJECT with "Bet not placed to this market"', () => {
  const sampleMatch = {
    teamA: 'India Legends',
    teamB: 'South Africa Legends',
    backOddsA: 1.76,
    layOddsA: 1.78,
    backOddsB: 2.08,
    layOddsB: 2.12
  };

  // User edited India Legends odds from 1.76 to 1.98
  const b1 = validateBetOdds(sampleMatch, 'India Legends', 1.98, 'back', 'match_odds');
  assert.equal(b1.valid, false);
  assert.equal(b1.error, 'Bet not placed to this market');

  // User edited to 99
  const b2 = validateBetOdds(sampleMatch, 'India Legends', 99, 'back', 'match_odds');
  assert.equal(b2.valid, false);
  assert.equal(b2.error, 'Bet not placed to this market');

  // User decreased SA Legends odds from 2.08 to 1.50
  const b3 = validateBetOdds(sampleMatch, 'South Africa Legends', 1.50, 'back', 'match_odds');
  assert.equal(b3.valid, false);
  assert.equal(b3.error, 'Bet not placed to this market');
});

test('Bookmaker Odds: strict validation against active bookmaker odds', () => {
  const sampleMatch = {
    teamA: 'India',
    teamB: 'Pakistan',
    bookmakerBackA: 1.85,
    bookmakerLayA: 1.88,
    bookmakerBackB: 2.10,
    bookmakerLayB: 2.14
  };

  const validBet = validateBetOdds(sampleMatch, 'India', 1.85, 'back', 'bookmaker');
  assert.equal(validBet.valid, true);

  const invalidBet = validateBetOdds(sampleMatch, 'India', 2.50, 'back', 'bookmaker');
  assert.equal(invalidBet.valid, false);
  assert.equal(invalidBet.error, 'Bet not placed to this market');
});
