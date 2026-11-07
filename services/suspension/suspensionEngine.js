// suspensionEngine.js — Live Orchestrator for Fancy, Fancy 2, Even/Odd, Last Figure
// Implements SUSPENSION_ENGINE_CONTEXT.md Section 5 ("Where it runs")

import {
  ballsToDecision,
  isStale,
  distStats,
  decidedProbability,
  detectEvents,
  initSm,
  step,
  worstCaseLiability,
  DEFAULT_CONFIG,
  REASON_PRIORITY,
} from './suspension.reference.js';

import Match from '../../models/Match.js';
import Bet from '../../models/Bet.js';
import SuspensionAudit from '../../models/SuspensionAudit.js';

/**
 * In-memory state machine tracking per match and market.
 * Map: matchId -> Map(marketKey -> sm)
 */
const matchSmStore = new Map();
const matchStateSeqMap = new Map();
const matchPrevStateMap = new Map();
const matchManualHoldMap = new Map(); // matchId -> Set(marketKey)

/** Active SSE clients subscribed to suspension streams */
const sseClients = new Map(); // matchId -> Set(res)

let ioInstance = null;
let timerHandle = null;

/** Parse overs string like "9.2" into total legal balls (9 * 6 + 2 = 56) */
export function parseLegalBalls(oversStr) {
  if (!oversStr) return 0;
  const parts = String(oversStr).trim().split('.');
  const overs = parseInt(parts[0], 10) || 0;
  const balls = parseInt(parts[1], 10) || 0;
  return overs * 6 + Math.min(balls, 6);
}

/** Extract total runs from score object or string like "80/2" */
export function parseRuns(scoreObj) {
  if (!scoreObj) return 0;
  if (typeof scoreObj.runs === 'number') return scoreObj.runs;
  const runsStr = scoreObj.teamA_runs || scoreObj.teamB_runs || '0';
  const val = parseInt(String(runsStr).split(/[\/-]/)[0], 10);
  return isNaN(val) ? 0 : val;
}

/** Parse market specifications from market names */
export function parseMarketSpec(market, sectionType) {
  const name = market.name || '';
  const lower = name.toLowerCase();

  let overN = market.overN || 10;
  let innings = market.innings || 1;
  let type = 'fancy2';
  let wicketN = undefined;

  if (sectionType === 'figure' || lower.includes('last figure') || lower.includes('figure')) {
    type = 'lastfigure';
    overN = 15;
  } else if (sectionType === 'evenodd' || lower.includes('even') || lower.includes('odd')) {
    type = 'evenodd';
    overN = 15;
  } else if (lower.includes('fall of') && lower.includes('wkt')) {
    type = 'fall_of_wicket';
    const matchWkt = lower.match(/fall of (\d+)/);
    wicketN = matchWkt ? parseInt(matchWkt[1], 10) : 1;
  } else if (lower.includes('run only')) {
    type = 'fancy2';
  } else {
    type = 'fancy2';
  }

  // Extract over number from name if present
  const overMatch = name.match(/(\d+)\s*Over/i);
  if (overMatch) {
    overN = parseInt(overMatch[1], 10);
  }
  if (lower.includes('2nd inn') || lower.includes('2nd innings')) {
    innings = 2;
  }

  return {
    id: market._id ? String(market._id) : name,
    name,
    type,
    overN,
    wicketN,
    innings,
    maxBet: market.maxBet || (type === 'lastfigure' ? 100000 : 2000000),
  };
}

/** Build quote object formatted for suspension evaluator */
export function buildQuote(marketSpec, market, stateSeq) {
  if (marketSpec.type === 'lastfigure') {
    const odds = (market.digits || []).map((d) => d.odds || 8.85);
    if (odds.length !== 10) return null;
    return { stateSeq, odds };
  }
  if (marketSpec.type === 'evenodd') {
    if (!market.backPrice || !market.layPrice) return null;
    return {
      stateSeq,
      backOdd: Number(market.backPrice),
      layOdd: Number(market.layPrice),
      backEven: Number(market.backPrice),
      layEven: Number(market.layPrice),
    };
  }
  // fancy2 / line
  if (market.backPrice !== null && market.backPrice !== undefined &&
      market.layPrice !== null && market.layPrice !== undefined) {
    return {
      stateSeq,
      yesLine: Number(market.backPrice),
      noLine: Number(market.layPrice),
    };
  }
  return null;
}

/** Compute worst-case liability from pending bets for a specific market */
export async function computeMarketExposure(matchId, marketName, marketSpec) {
  try {
    const activeBets = await Bet.find({
      matchId,
      runner: { $regex: new RegExp(`^${marketName}`, 'i') },
      status: 'MATCHED',
    }).lean();

    if (!activeBets || activeBets.length === 0) return 0;

    if (marketSpec.type === 'lastfigure') {
      const outcomes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      const settleFn = (bet, outcome) => {
        const betDigit = parseInt(String(bet.runner).split('Digit ')[1] || '0', 10);
        return betDigit === outcome ? bet.stake * ((bet.odds || 8.85) - 1) : -bet.stake;
      };
      const { liability } = worstCaseLiability(activeBets, outcomes, settleFn);
      return liability;
    }

    if (marketSpec.type === 'evenodd') {
      const outcomes = ['odd', 'even'];
      const settleFn = (bet, outcome) => {
        const isBetOdd = bet.type === 'back';
        const userWon = (outcome === 'odd' && isBetOdd) || (outcome === 'even' && !isBetOdd);
        return userWon ? bet.stake * ((bet.odds || 1.98) - 1) : -bet.stake;
      };
      const { liability } = worstCaseLiability(activeBets, outcomes, settleFn);
      return liability;
    }

    // fancy2 / line
    const currentRuns = 50;
    const outcomes = Array.from({ length: 60 }, (_, i) => currentRuns + i);
    const settleFn = (bet, x) => {
      const line = Number(bet.odds || 0);
      const isYes = bet.type === 'back';
      const won = (isYes && x >= line) || (!isYes && x < line);
      return won ? bet.stake : -bet.stake;
    };
    const { liability } = worstCaseLiability(activeBets, outcomes, settleFn);
    return liability;
  } catch (err) {
    console.error(`[SuspensionEngine] Error computing exposure for ${marketName}:`, err.message);
    return 0;
  }
}

/**
 * Evaluate all markets for a given match.
 * Idempotent, safe, and logs status audits on change.
 */
export async function evaluateMatch(matchId, options = {}) {
  try {
    const match = await Match.findOne({ matchId }).lean();
    if (!match) return;

    const now = options.now || Date.now();
    const isLive = match.status === 'live' || match.inplay === true;

    // Track sequence and previous state
    let stateSeq = (matchStateSeqMap.get(matchId) || 0) + 1;
    if (options.stateSeq) stateSeq = options.stateSeq;
    matchStateSeqMap.set(matchId, stateSeq);

    const legalBalls = parseLegalBalls(match.score?.overs);
    const runs = parseRuns(match.score);
    const wickets = match.score?.wickets || 0;
    const innings = match.score?.innings || 1;

    const curSt = {
      innings,
      runs,
      wickets,
      legalBalls,
      stateSeq,
      status: match.status || 'upcoming',
      lastBall: match.score?.lastBall ? { note: match.score.lastBall } : null,
    };
    const prevSt = matchPrevStateMap.get(matchId) || curSt;
    matchPrevStateMap.set(matchId, curSt);

    // Get match state machine store
    if (!matchSmStore.has(matchId)) matchSmStore.set(matchId, new Map());
    const smMap = matchSmStore.get(matchId);

    const feedLastUpdateMs = match.score?.lastUpdated
      ? new Date(match.score.lastUpdated).getTime()
      : (match.lastUpdated ? new Date(match.lastUpdated).getTime() : now);

    const validatorOk = options.validatorOk !== undefined ? options.validatorOk : true;

    const sections = [
      { key: 'fancyMarkets', type: 'fancy2' },
      { key: 'figureMarkets', type: 'figure' },
      { key: 'evenOddMarkets', type: 'evenodd' },
    ];

    let hasChanges = false;
    const auditRows = [];
    const updatedSections = {};

    for (const sec of sections) {
      const marketsList = match[sec.key] || [];
      const updatedList = [];

      for (const m of marketsList) {
        const spec = parseMarketSpec(m, sec.type);
        const mKey = spec.name;

        let sm = smMap.get(mKey) || initSm();

        // Check manual hold toggle
        const manualHolds = matchManualHoldMap.get(matchId) || new Set();
        const isManuallyHeld = manualHolds.has(mKey) || Boolean(m.manualHold);

        // Exposure calculation
        const liability = await computeMarketExposure(matchId, spec.name, spec);
        const exposureRatio = spec.maxBet > 0 ? liability / spec.maxBet : 0;

        const quote = buildQuote(spec, m, stateSeq);
        const btd = ballsToDecision(spec, curSt);
        const runsAtOverEndKnown = btd === 0;

        const ctx = {
          now,
          matchStatus: match.status || 'upcoming',
          st: curSt,
          prevSt,
          feedLastUpdateMs,
          validatorOk,
          quote,
          stats: null, // Connected to pricing engine when active
          pEarlyEnd: 0,
          exposureRatio,
          manualHold: isManuallyHeld,
          runsAtOverEndKnown,
        };

        const res = step(sm, spec, ctx, DEFAULT_CONFIG);
        smMap.set(mKey, res.sm);

        const newStatus = res.status.toUpperCase(); // 'OPEN' or 'SUSPENDED'
        const oldStatus = m.status || 'SUSPENDED';
        const oldReasons = m.reasons || [];
        const newReasons = res.reasons;
        const topReason = res.reasons.length > 0 ? res.reasons[0] : null;

        const statusChanged = newStatus !== oldStatus;
        const reasonsChanged = JSON.stringify(oldReasons) !== JSON.stringify(newReasons);

        if (statusChanged || reasonsChanged) {
          hasChanges = true;
          auditRows.push({
            matchId,
            marketName: spec.name,
            marketType: spec.type,
            oldStatus,
            newStatus,
            oldReasons,
            newReasons,
            topReason,
            stateSeq,
            modelVersion: 'suspension-v1.0',
            ctxSummary: {
              now,
              matchStatus: match.status,
              legalBalls,
              wickets,
              runs,
              innings,
              feedStale: isStale(now, feedLastUpdateMs, DEFAULT_CONFIG.staleMs),
              exposureRatio,
              pEarlyEnd: 0,
            },
          });
        }

        updatedList.push({
          ...m,
          status: newStatus,
          reasons: newReasons,
          topReason,
          statusSince: statusChanged ? new Date(now) : (m.statusSince || new Date(now)),
          manualHold: isManuallyHeld,
        });
      }

      updatedSections[sec.key] = updatedList;
    }

    // Persist changes and audit rows
    if (hasChanges) {
      await Match.updateOne(
        { matchId },
        {
          $set: {
            fancyMarkets: updatedSections.fancyMarkets,
            figureMarkets: updatedSections.figureMarkets,
            evenOddMarkets: updatedSections.evenOddMarkets,
          },
        }
      );

      if (auditRows.length > 0) {
        try {
          await SuspensionAudit.insertMany(auditRows, { ordered: false });
        } catch (e) {
          // ignore duplicate key or non-fatal audit insert errors
        }
      }

      // Broadcast changes via Socket.IO
      const io = ioInstance;
      if (io) {
        io.emit('fancy_market_update', { matchId, fancyMarkets: updatedSections.fancyMarkets });
        io.emit('figure_market_update', { matchId, figureMarkets: updatedSections.figureMarkets });
        io.emit('even_odd_market_update', { matchId, evenOddMarkets: updatedSections.evenOddMarkets });
        io.emit('suspension_status_update', {
          matchId,
          fancyMarkets: updatedSections.fancyMarkets,
          figureMarkets: updatedSections.figureMarkets,
          evenOddMarkets: updatedSections.evenOddMarkets,
        });
      }

      // Push SSE update to subscribed clients
      pushSSE(matchId, {
        matchId,
        timestamp: now,
        fancyMarkets: updatedSections.fancyMarkets,
        figureMarkets: updatedSections.figureMarkets,
        evenOddMarkets: updatedSections.evenOddMarkets,
      });
    }

    return updatedSections;
  } catch (err) {
    console.error(`[SuspensionEngine] Error evaluating match ${matchId}:`, err);
  }
}

/** Push Server-Sent Events (SSE) to connected clients */
export function pushSSE(matchId, payload) {
  const clients = sseClients.get(matchId);
  if (!clients || clients.size === 0) return;
  const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(dataStr);
    } catch (e) {
      clients.delete(res);
    }
  }
}

/** SSE handler endpoint for HTTP router */
export function handleSSEStream(req, res) {
  const matchId = req.params.matchId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!sseClients.has(matchId)) {
    sseClients.set(matchId, new Set());
  }
  const clients = sseClients.get(matchId);
  clients.add(res);

  // Send initial ping
  res.write(`data: ${JSON.stringify({ type: 'connected', matchId })}\n\n`);

  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(matchId);
  });
}

/** Trader manual hold toggle kill switch */
export async function setManualHold(matchId, marketName, isHeld) {
  if (!matchManualHoldMap.has(matchId)) {
    matchManualHoldMap.set(matchId, new Set());
  }
  const holds = matchManualHoldMap.get(matchId);
  if (isHeld) {
    holds.add(marketName);
  } else {
    holds.delete(marketName);
  }
  return evaluateMatch(matchId, { now: Date.now() });
}

/** Start the 1-second background evaluation timer */
export function init(io) {
  ioInstance = io;
  if (timerHandle) clearInterval(timerHandle);

  // 1-second interval timer for holds and staleness evaluation
  timerHandle = setInterval(async () => {
    try {
      const activeMatches = await Match.find({
        status: { $in: ['live', 'upcoming'] },
      }).select('matchId status inplay').lean();

      const now = Date.now();
      for (const m of activeMatches) {
        await evaluateMatch(m.matchId, { now });
      }
    } catch (err) {
      // Non-fatal periodic tick error
    }
  }, 1000);

  console.log('✅ SuspensionEngine initialized: evaluation on stateSeq changes + 1-second timer');
}

export function stop() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

export default {
  init,
  stop,
  evaluateMatch,
  setManualHold,
  handleSSEStream,
  parseLegalBalls,
  parseRuns,
  parseMarketSpec,
  buildQuote,
};
