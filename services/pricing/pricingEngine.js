// services/pricing/pricingEngine.js
// Orchestrates calibrated Monte Carlo simulation pricing for Fancy 2, Figure, and Even/Odd markets.
// Implements ODDS_CALCULATION_CONTEXT.md Sections 2, 3, 4, 5.

import * as O from './odds-calc.reference.js';

const stateSeqMap = new Map(); // matchId -> stateSeq

/** Parse overs string like "35.1" or "9.2" into legal balls bowled */
export function parseLegalBalls(oversStr) {
  if (!oversStr) return 0;
  const parts = String(oversStr).trim().split('.');
  const overs = parseInt(parts[0], 10) || 0;
  const balls = parseInt(parts[1], 10) || 0;
  return overs * 6 + Math.min(balls, 6);
}

/** Extract total runs from score object or string like "211/5" */
export function parseRuns(scoreVal) {
  if (scoreVal === undefined || scoreVal === null) return 0;
  if (typeof scoreVal === 'number') return scoreVal;
  const runsStr = typeof scoreVal === 'string' ? scoreVal : (scoreVal.teamA_runs || scoreVal.teamB_runs || scoreVal.runs || '0');
  const val = parseInt(String(runsStr).split(/[\/-]/)[0], 10);
  return isNaN(val) ? 0 : val;
}

/** Detect match format: 'T20' | 'ODI' | 'TEST' */
export function detectFormat(match) {
  // 1. Explicit format string on match or match.score
  const rawFmt = String(match?.format || match?.score?.format || match?.sportmonksFormat || '').toLowerCase();
  if (rawFmt === 'test' || rawFmt === 'first_class') return 'TEST';
  if (rawFmt === 'oneday' || rawFmt === 'odi' || rawFmt === 'one_day' || rawFmt === '50_over') return 'ODI';
  if (rawFmt === 't20' || rawFmt === 'twenty20' || rawFmt === 't10') return 'T20';

  // 2. Overs per innings from play or score
  const oversPerInn = Number(match?.oversPerInnings || match?.score?.oversPerInnings || match?.play?.overs_per_innings);
  if (oversPerInn > 20) return 'ODI';
  if (oversPerInn > 0 && oversPerInn <= 20) return 'T20';

  // 3. Current live overs bowled: over 20 bowled cannot be T20!
  const oversStr = String(match?.score?.overs || '');
  const legalBalls = parseLegalBalls(oversStr);
  if (legalBalls > 300) return 'TEST';
  if (legalBalls > 120) return 'ODI';

  // 4. Text matching on league, tournament, team names, match title
  const str = `${match?.league || ''} ${match?.tournament?.name || ''} ${match?.name || ''} ${match?.teamA || ''} ${match?.teamB || ''}`.toLowerCase();
  if (Boolean(match?.isTestMatch || match?.backOddsDraw != null || /\b(test|ashes|border gavaskar|wtc|sheffield|ranji|first class|first-class)\b/i.test(str))) {
    return 'TEST';
  }
  if (/\b(odi|one day|one-day|cwc|world cup|champions trophy|50 overs?|league two)\b/i.test(str)) {
    return 'ODI';
  }
  return 'T20';
}

/** Get short team abbreviation (e.g. "Australia" -> "AUS-L", "England" -> "ENG-L") */
export function getShortTeamCode(teamName) {
  if (!teamName) return 'TEAM';
  const clean = teamName.trim();
  const lower = clean.toLowerCase();
  if (lower.includes('south africa')) return 'SA-L';
  if (lower.includes('west indies')) return 'WI-L';
  if (lower.includes('australia')) return 'AUS-L';
  if (lower.includes('pakistan')) return 'PAK-L';
  if (lower.includes('india')) return 'IND-L';
  if (lower.includes('england')) return 'ENG-L';
  if (lower.includes('bangladesh')) return 'BAN-L';
  if (lower.includes('sri lanka') || lower.includes('srilanka')) return 'SL-L';
  if (lower.includes('new zealand') || lower.includes('newzealand')) return 'NZ-L';
  if (lower.includes('afghanistan')) return 'AFG-L';
  if (lower.includes('ireland')) return 'IRE';
  if (lower.includes('netherlands')) return 'NED';
  if (lower.includes('scotland')) return 'SCO';
  if (lower.includes('zimbabwe')) return 'ZIM';

  const words = clean.split(/\s+/);
  if (words.length >= 2) {
    return words.map(w => w[0].toUpperCase()).join('');
  }
  return clean.slice(0, 4).toUpperCase();
}

/**
 * Compute calibrated Monte Carlo odds for Fancy 2, Figure, and Even/Odd markets.
 * Recompute on every state change and every 5s.
 */
export function computeMatchOdds(match, options = {}) {
  if (!match) return null;

  const matchId = String(match.matchId || match.id || 'match');
  const now = options.now || Date.now();
  const isLive = match.status === 'live' ||
                 match.inplay === true ||
                 match.status === 'inplay' ||
                 match.status === 'started' ||
                 Boolean(match.score?.overs && match.score.overs !== '0' && match.score.overs !== '0.0' && match.score.overs !== 'Final');

  // Increment stateSeq
  let stateSeq = (stateSeqMap.get(matchId) || 0) + 1;
  if (options.stateSeq) stateSeq = options.stateSeq;
  stateSeqMap.set(matchId, stateSeq);

  const formatKey = detectFormat(match);
  const fmt = O.FORMATS[formatKey] || O.FORMATS.T20;

  // Active batting state
  const sc = match.score || {};
  const battingTeamKey = sc.battingTeam || (sc.teamB_runs && sc.teamB_runs !== '0/0' && sc.teamB_runs !== '0' ? 'teamB' : 'teamA');
  const isTeamABatting = battingTeamKey === 'teamA';
  const battingTeamName = sc.battingTeamName || (isTeamABatting ? match.teamA : match.teamB) || 'Batting Team';
  const bowlingTeamName = sc.bowlingTeamName || (isTeamABatting ? match.teamB : match.teamA) || 'Bowling Team';

  const shortBatting = getShortTeamCode(battingTeamName);
  const shortBowling = getShortTeamCode(bowlingTeamName);

  const rawRunsStr = isTeamABatting ? (sc.teamA_runs || sc.runs) : (sc.teamB_runs || sc.runs);
  const runs = parseRuns(rawRunsStr);
  const wickets = typeof sc.wickets === 'number' ? sc.wickets : (isTeamABatting ? (sc.teamA_wickets || 0) : (sc.teamB_wickets || 0));
  const legalBalls = parseLegalBalls(sc.overs);
  const target = (sc.target && Number(sc.target) > 0) ? Number(sc.target) : null;
  const currentOver = Math.floor(legalBalls / 6);

  const st = {
    runs: Math.max(0, runs),
    wickets: Math.min(10, Math.max(0, wickets)),
    legalBalls: Math.min(fmt.maxBalls, Math.max(0, legalBalls)),
    target: target
  };

  const lambda = O.liveLambda(fmt, st);
  const baseSeed = (stateSeq * 10007 + legalBalls * 31 + runs * 17) & 0x7fffffff;

  // Simulation cache per target over (memoized across markets)
  const simCache = new Map();
  function getOverStats(overN) {
    if (simCache.has(overN)) return simCache.get(overN);
    if (st.legalBalls >= overN * 6) return null; // already completed

    const sim = O.simulate(st, fmt, { kind: 'runsAtOver', overN }, {
      nSims: 10000,
      seed: (baseSeed + overN * 97) | 0,
      lambda
    });
    const stats = O.distStats(sim.samples);
    const res = { sim, stats, pEarlyEnd: sim.pEarlyEnd };
    simCache.set(overN, res);
    return res;
  }

  // Determine target overs based on match format and current over
  const milestoneOvers = formatKey === 'ODI'
    ? [10, 15, 20, 25, 30, 35, 40, 45, 50]
    : (formatKey === 'TEST' ? [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] : [6, 7, 8, 10, 15, 20]);

  const maxOvers = formatKey === 'ODI' ? 50 : (formatKey === 'TEST' ? 100 : 20);

  // Upcoming overs for Fancy 2
  const relevantOvers = [];
  // Include existing configured milestone overs
  for (const mo of milestoneOvers) {
    if (mo > currentOver) relevantOvers.push(mo);
    else if (mo >= currentOver - 2 && !relevantOvers.includes(mo)) relevantOvers.push(mo);
  }
  // Add next consecutive over if in-play
  if (isLive && currentOver + 1 <= maxOvers && !relevantOvers.includes(currentOver + 1)) {
    relevantOvers.push(currentOver + 1);
  }
  relevantOvers.sort((a, b) => a - b);

  // 1. Build Fancy 2 markets
  const fancyMarkets = [];
  const statsByMarket = new Map();

  for (const ov of relevantOvers) {
    const label = `${ov} Over Run ${shortBatting}`;
    const overRes = getOverStats(ov);
    const ballsLeft = ov * 6 - st.legalBalls;

    if (!overRes || ballsLeft <= 0) {
      // Completed / Awaiting Settlement
      fancyMarkets.push({
        name: label,
        overN: ov,
        backPrice: null,
        backVol: '100',
        layPrice: null,
        layVol: '100',
        status: 'SUSPENDED',
        maxBet: 2000000
      });
    } else if (ballsLeft <= 3) {
      // End Zone (last 3 balls)
      fancyMarkets.push({
        name: label,
        overN: ov,
        backPrice: null,
        backVol: '100',
        layPrice: null,
        layVol: '100',
        status: 'SUSPENDED',
        maxBet: 2000000
      });
    } else {
      // Active open quote
      const spread = O.fancySpread(overRes.stats, { margin: 0.02 });
      fancyMarkets.push({
        name: label,
        overN: ov,
        backPrice: spread.yesLine,
        backVol: '100',
        layPrice: spread.noLine,
        layVol: '100',
        status: isLive ? 'OPEN' : 'SUSPENDED',
        maxBet: 2000000
      });
      statsByMarket.set(label, { stats: overRes.stats, pEarlyEnd: overRes.pEarlyEnd });
    }
  }

  // Fall of next wickets
  const nextWicket1 = st.wickets + 1;
  const nextWicket2 = st.wickets + 2;

  const wktList = [
    { n: 1, label: `Fall of 1st Wkt ${shortBatting}` },
    { n: 2, label: `Fall of 2nd Wkt ${shortBatting}` },
    { n: 3, label: `Fall of 3rd Wkt ${shortBatting}` }
  ];
  if (nextWicket1 > 3 && nextWicket1 <= 10) {
    wktList.push({ n: nextWicket1, label: `Fall of ${nextWicket1}th Wkt ${shortBatting}` });
  }
  if (nextWicket2 > 3 && nextWicket2 <= 10) {
    wktList.push({ n: nextWicket2, label: `Fall of ${nextWicket2}th Wkt ${shortBatting}` });
  }

  for (const wItem of wktList) {
    if (st.wickets >= wItem.n) {
      fancyMarkets.push({
        name: wItem.label,
        wicketN: wItem.n,
        backPrice: null,
        backVol: '100',
        layPrice: null,
        layVol: '100',
        status: 'SUSPENDED',
        maxBet: 2000000
      });
    } else {
      try {
        const wktSim = O.simulate(st, fmt, { kind: 'runsAtWicket', n: wItem.n }, {
          nSims: 8000,
          seed: (baseSeed + wItem.n * 1013) | 0,
          lambda
        });
        const wktStats = O.distStats(wktSim.samples);
        const spread = O.fancySpread(wktStats, { margin: 0.02 });
        fancyMarkets.push({
          name: wItem.label,
          wicketN: wItem.n,
          backPrice: spread.yesLine,
          backVol: '100',
          layPrice: spread.noLine,
          layVol: '100',
          status: isLive ? 'OPEN' : 'SUSPENDED',
          maxBet: 2000000
        });
        statsByMarket.set(wItem.label, { stats: wktStats, pEarlyEnd: wktSim.pEarlyEnd });
      } catch (e) {
        fancyMarkets.push({
          name: wItem.label,
          wicketN: wItem.n,
          backPrice: null,
          backVol: '100',
          layPrice: null,
          layVol: '100',
          status: 'SUSPENDED',
          maxBet: 2000000
        });
      }
    }
  }

  // 2. Build Figure markets (0-9 Digits)
  let figureTargetOver = 15;
  if (formatKey === 'ODI') {
    if (currentOver < 15) figureTargetOver = 15;
    else if (currentOver < 25) figureTargetOver = 25;
    else if (currentOver < 35) figureTargetOver = 35;
    else if (currentOver < 40) figureTargetOver = 40;
    else figureTargetOver = 50;
  } else if (formatKey === 'TEST') {
    figureTargetOver = (Math.floor(currentOver / 10) + 1) * 10;
  } else {
    // T20
    if (currentOver < 6) figureTargetOver = 6;
    else if (currentOver < 10) figureTargetOver = 10;
    else if (currentOver < 15) figureTargetOver = 15;
    else figureTargetOver = 20;
  }

  // If the target over is within 3 balls of ending or past, pick the next available upcoming over
  if (figureTargetOver * 6 - st.legalBalls <= 3) {
    const nextAvail = relevantOvers.find(o => o * 6 - st.legalBalls > 3);
    if (nextAvail) figureTargetOver = nextAvail;
  }

  const figMarketName = `${battingTeamName.toUpperCase()} ${figureTargetOver} OVER TOTAL LAST FIGURE`;
  const figOverRes = getOverStats(figureTargetOver);
  const figBallsLeft = figureTargetOver * 6 - st.legalBalls;

  let figureMarkets = [];
  if (!figOverRes || figBallsLeft <= 3) {
    figureMarkets = [{
      name: figMarketName,
      maxBet: 100000,
      status: 'SUSPENDED',
      digits: Array.from({ length: 10 }, (_, i) => ({
        digit: i,
        odds: 8.85,
        status: 'SUSPENDED'
      }))
    }];
  } else {
    const lf = O.lastFigure(figOverRes.stats, { margin: 0.115 });
    figureMarkets = [{
      name: figMarketName,
      maxBet: 100000,
      status: isLive ? 'OPEN' : 'SUSPENDED',
      digits: Array.from({ length: 10 }, (_, i) => ({
        digit: i,
        odds: lf.odds[i] || 8.85,
        status: isLive ? 'OPEN' : 'SUSPENDED'
      }))
    }];
    statsByMarket.set(figMarketName, { stats: figOverRes.stats, pEarlyEnd: figOverRes.pEarlyEnd });
  }

  // 3. Build Even/Odd markets
  const evenOddTargets = [];
  if (formatKey === 'ODI') {
    if (currentOver < 15) evenOddTargets.push(15, 20);
    else if (currentOver < 25) evenOddTargets.push(25, 30);
    else if (currentOver < 35) evenOddTargets.push(35, 40);
    else if (currentOver < 48) evenOddTargets.push(40, 50);
    else evenOddTargets.push(50);
  } else if (formatKey === 'TEST') {
    const next10 = (Math.floor(currentOver / 10) + 1) * 10;
    evenOddTargets.push(next10);
  } else {
    // T20
    if (currentOver < 10) evenOddTargets.push(10, 15);
    else if (currentOver < 15) evenOddTargets.push(15, 20);
    else evenOddTargets.push(20);
  }

  // Include next consecutive over if active and not in end zone
  if (isLive && currentOver + 1 <= maxOvers && (currentOver + 1) * 6 - st.legalBalls > 3) {
    if (!evenOddTargets.includes(currentOver + 1)) evenOddTargets.unshift(currentOver + 1);
  }
  evenOddTargets.sort((a, b) => a - b);

  const evenOddMarkets = [];
  for (const eoOv of evenOddTargets) {
    const eoName = `1st inn ${eoOv} Over Run Odd (Kalli)`;
    const eoRes = getOverStats(eoOv);
    const eoBallsLeft = eoOv * 6 - st.legalBalls;

    if (!eoRes || eoBallsLeft <= 3) {
      evenOddMarkets.push({
        name: eoName,
        backPrice: null,
        backVol: '100',
        layPrice: null,
        layVol: '100',
        status: 'SUSPENDED',
        maxBet: 2000000
      });
    } else {
      const eo = O.evenOdd(eoRes.stats, { margin: 0.01 });
      evenOddMarkets.push({
        name: eoName,
        backPrice: eo.odd.back,
        backVol: '100',
        layPrice: eo.odd.lay,
        layVol: '100',
        status: isLive ? 'OPEN' : 'SUSPENDED',
        maxBet: 2000000
      });
      statsByMarket.set(eoName, { stats: eoRes.stats, pEarlyEnd: eoRes.pEarlyEnd });
    }
  }

  return {
    stateSeq,
    format: formatKey,
    runs,
    wickets,
    legalBalls,
    currentOver,
    battingTeamName,
    bowlingTeamName,
    fancyMarkets,
    figureMarkets,
    evenOddMarkets,
    statsByMarket
  };
}

export default {
  computeMatchOdds,
  parseLegalBalls,
  parseRuns,
  detectFormat,
  getShortTeamCode
};
