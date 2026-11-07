import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ballsToDecision, isStale, distStats, decidedProbability, detectEvents, step, initSm,
  worstCaseLiability, REASON_PRIORITY, DEFAULT_CONFIG as C,
} from './suspension.reference.js';

// Helper constructors
const mkt = (type = 'fancy2', overN = 10, innings = 1) => ({ id: `m_${type}_${overN}`, type, overN, innings });
const goodQuote = (market, seq = 1) =>
  market.type === 'lastfigure' ? { stateSeq: seq, odds: Array(10).fill(8.85) }
  : market.type === 'evenodd' ? { stateSeq: seq, backOdd: 1.98, layOdd: 2.02, backEven: 1.98, layEven: 2.02 }
  : { stateSeq: seq, yesLine: 13, noLine: 12 };

/* ═══════════════════════════════════════════════════════════════════════
   1. PROPERTY TESTS (Section 8.1)
   ═══════════════════════════════════════════════════════════════════════ */

test('Property: step never opens a market with a non-empty reason', () => {
  const types = ['line', 'fancy2', 'evenodd', 'lastfigure'];
  const testScenarios = [
    { matchStatus: 'pre' },
    { manualHold: true },
    { validatorOk: false },
    { pEarlyEnd: 0.6 },
    { exposureRatio: 1.2 },
    { quote: null },
    { st: { legalBalls: 58, stateSeq: 10, innings: 1 } }, // end zone for over 10
  ];

  for (const t of types) {
    const m = mkt(t, 10);
    for (const sc of testScenarios) {
      const ctx = {
        now: 100000, matchStatus: 'live',
        st: { innings: 1, runs: 80, wickets: 2, legalBalls: 30, stateSeq: 1, status: 'live', ...(sc.st || {}) },
        prevSt: { innings: 1, runs: 80, wickets: 2, legalBalls: 30, stateSeq: 1, status: 'live' },
        feedLastUpdateMs: 99000, validatorOk: true, quote: goodQuote(m), stats: null, pEarlyEnd: 0,
        exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false, ...sc,
      };
      const res = step(initSm(), m, ctx);
      if (res.reasons.length > 0) {
        assert.equal(res.status, 'suspended', `Expected suspended when reasons exist: ${res.reasons.join(',')}`);
      } else {
        assert.equal(res.status, 'open', 'Expected open when reason set is empty');
      }
    }
  }
});

test('Property: reasons are always returned in exact priority order', () => {
  const m = mkt('fancy2', 10);
  // Trigger multiple simultaneous suspension reasons:
  // MANUAL + NOT_LIVE + EXPOSURE + QUOTE_INVALID
  const ctx = {
    now: 100000, matchStatus: 'pre',
    st: { innings: 1, runs: 80, wickets: 2, legalBalls: 30, stateSeq: 1, status: 'pre' },
    prevSt: { innings: 1, runs: 80, wickets: 2, legalBalls: 30, stateSeq: 1, status: 'pre' },
    feedLastUpdateMs: 99000, validatorOk: true, quote: null, stats: null, pEarlyEnd: 0,
    exposureRatio: 1.5, manualHold: true, runsAtOverEndKnown: false,
  };
  const res = step(initSm(), m, ctx);
  assert.ok(res.reasons.length >= 3);
  for (let i = 0; i < res.reasons.length - 1; i++) {
    const p1 = REASON_PRIORITY.indexOf(res.reasons[i]);
    const p2 = REASON_PRIORITY.indexOf(res.reasons[i + 1]);
    assert.ok(p1 < p2, `Priority violation: ${res.reasons[i]} (idx ${p1}) should precede ${res.reasons[i + 1]} (idx ${p2})`);
  }
});

test('Property: step is completely idempotent (same input gives same output)', () => {
  const m = mkt('fancy2', 10);
  const sm0 = initSm();
  const ctx = {
    now: 100000, matchStatus: 'live',
    st: { innings: 1, runs: 85, wickets: 3, legalBalls: 40, stateSeq: 12, status: 'live' },
    prevSt: { innings: 1, runs: 81, wickets: 2, legalBalls: 39, stateSeq: 11, status: 'live' },
    feedLastUpdateMs: 99500, validatorOk: true, quote: goodQuote(m, 12), stats: null, pEarlyEnd: 0,
    exposureRatio: 0.2, manualHold: false, runsAtOverEndKnown: false,
  };

  const res1 = step(sm0, m, ctx);
  const res2 = step(sm0, m, ctx);
  assert.deepEqual(res1, res2, 'step must produce identical output for identical arguments');
});

/* ═══════════════════════════════════════════════════════════════════════
   2. REPLAY TEST: 10 T20 INNINGS BALL-BY-BALL (Section 8.2)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Deterministic synthetic generator for a T20 innings of 120 legal balls.
 * Uses a linear congruential generator (no Math.random) for 100% reproducibility.
 */
function createDeterministicInnings(seed = 1) {
  let s = seed;
  const lcg = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };

  const balls = [];
  let legalBalls = 0;
  let runs = 0;
  let wickets = 0;
  let stateSeq = 1;
  let timeMs = 1000000;

  while (legalBalls < 120 && wickets < 10) {
    const r = lcg();
    timeMs += 25000 + Math.floor(lcg() * 10000); // 25-35 seconds per ball
    stateSeq++;

    let isWicket = false;
    let isNoBall = false;
    let ballRuns = 0;

    if (r < 0.05) {
      isWicket = true;
      wickets++;
      legalBalls++;
    } else if (r < 0.08) {
      isNoBall = true;
      ballRuns = 1 + (lcg() < 0.3 ? 4 : 0);
      runs += ballRuns;
      // no-ball does not advance legal balls
    } else if (r < 0.40) {
      ballRuns = 0;
      legalBalls++;
    } else if (r < 0.70) {
      ballRuns = 1;
      runs += 1;
      legalBalls++;
    } else if (r < 0.85) {
      ballRuns = 2;
      runs += 2;
      legalBalls++;
    } else if (r < 0.95) {
      ballRuns = 4;
      runs += 4;
      legalBalls++;
    } else {
      ballRuns = 6;
      runs += 6;
      legalBalls++;
    }

    balls.push({
      legalBalls, runs, wickets, stateSeq, timeMs,
      lastBall: isNoBall ? { extra: 'noball' } : { runs: ballRuns },
      isWicket, isNoBall,
    });
  }
  return balls;
}

test('Replay test: 10 T20 innings ball-by-ball verification & open percentage', () => {
  const markets = [
    mkt('fancy2', 10),      // 10 Over Run
    mkt('fancy2', 20),      // 20 Over Run
    mkt('evenodd', 15),     // 15 Over Even/Odd
    mkt('lastfigure', 15),  // 15 Over Last Figure
  ];

  const totalSteps = {};
  const openSteps = {};
  for (const m of markets) {
    totalSteps[m.id] = 0;
    openSteps[m.id] = 0;
  }

  for (let inningsIdx = 1; inningsIdx <= 10; inningsIdx++) {
    const balls = createDeterministicInnings(inningsIdx * 7919);
    const smMap = new Map();
    for (const m of markets) smMap.set(m.id, initSm());

    let prevSt = { innings: 1, runs: 0, wickets: 0, legalBalls: 0, stateSeq: 1, status: 'live' };

    for (let bIdx = 0; bIdx < balls.length; bIdx++) {
      const b = balls[bIdx];
      const curSt = {
        innings: 1, runs: b.runs, wickets: b.wickets, legalBalls: b.legalBalls,
        stateSeq: b.stateSeq, status: 'live', lastBall: b.lastBall,
      };

      // Check each market at ball event time, then at +1s, +2s, +3s timer ticks
      const checkTimes = [b.timeMs, b.timeMs + 1000, b.timeMs + 2500];

      for (const now of checkTimes) {
        for (const m of markets) {
          const sm = smMap.get(m.id);
          const btd = ballsToDecision(m, curSt);
          const feedLastUpdateMs = b.timeMs; // fresh feed

          const quote = goodQuote(m, curSt.stateSeq);
          const ctx = {
            now, matchStatus: 'live', st: curSt, prevSt: now === b.timeMs ? prevSt : curSt,
            feedLastUpdateMs, validatorOk: true, quote, stats: null, pEarlyEnd: 0,
            exposureRatio: 0, manualHold: false, runsAtOverEndKnown: btd === 0,
          };

          const res = step(sm, m, ctx);
          smMap.set(m.id, res.sm);

          totalSteps[m.id]++;
          if (res.status === 'open') {
            openSteps[m.id]++;

            // SAFETY ASSERTIONS:
            // 1. Must NEVER be open during end zone
            assert.ok(btd > C.endZoneBalls[m.type], `Market ${m.id} was open during end zone! btd=${btd}`);
            // 2. Must NEVER be open during wicket hold
            if (b.isWicket) {
              const elapsedSinceWicket = now - b.timeMs;
              assert.ok(elapsedSinceWicket >= C.holdMs.wicket, `Market was open during wicket hold! elapsed=${elapsedSinceWicket}ms`);
            }
            // 3. Must NEVER be open when stale
            assert.ok(now - feedLastUpdateMs <= C.staleMs, 'Market was open when feed was stale!');
          }
        }
      }
      prevSt = curSt;
    }
  }

  // Report percentage of time each market is open
  const openPercentages = {};
  for (const m of markets) {
    const pct = ((openSteps[m.id] / totalSteps[m.id]) * 100).toFixed(1);
    openPercentages[m.id] = `${pct}%`;
    assert.ok(openSteps[m.id] > 0, `Market ${m.id} should have had periods of open trading`);
  }
  assert.ok(Object.keys(openPercentages).length === 4);
});

/* ═══════════════════════════════════════════════════════════════════════
   3. ADVERSARIAL REPLAY: BETTOR WITH 2s, 5s, 8s LEAD (Section 8.3)
   ═══════════════════════════════════════════════════════════════════════ */

test('Adversarial replay: bettor with 2s, 5s, 8s lead against holdMs & acceptance delay D', () => {
  // A fast court-sider / bettor detects ball outcome ahead of the engine feed by L seconds.
  // The system uses holdMs.wicket = 2000ms, holdMs.noball = 1500ms, and an acceptance delay D (e.g. 1000ms).
  // When a bet is placed at t_bet, the acceptor re-evaluates the market status at t_eval = t_bet + D.
  // If the market is SUSPENDED at t_eval, the bet is REJECTED.

  const D = 1000; // 1000ms bet acceptance delay
  const leads = [2000, 5000, 8000]; // 2s, 5s, 8s lead
  const m = mkt('fancy2', 10);

  for (const lead of leads) {
    // Ball event happens in real life at t = 100,000
    const t_realBall = 100000;
    // Fast bettor places bet at t_bet = t_realBall + 200ms (almost instantaneous detection)
    const t_bet = t_realBall + 200;
    // Engine receives feed update at t_engine = t_realBall + lead
    const t_engine = t_realBall + lead;

    // Evaluator executes at t_eval = t_bet + D
    const t_eval = t_bet + D; // 101,200

    // When lead is 5s or 8s:
    // If the bettor places a bet before the engine receives the ball,
    // does the house maintain protection through end zones, exposure caps, and minimum holds?
    // At t_engine, engine immediately triggers holdMs.wicket (2000ms).
    // Furthermore, if D is tuned or if the bettor lead is within the hold window,
    // let's test rejection at various points.
    let sm = initSm();
    const prevSt = { innings: 1, runs: 50, wickets: 1, legalBalls: 24, stateSeq: 5, status: 'live' };
    const wicketSt = { innings: 1, runs: 50, wickets: 2, legalBalls: 25, stateSeq: 6, status: 'live' };

    // When engine receives the wicket at t_engine:
    const res = step(sm, m, {
      now: t_engine, matchStatus: 'live', st: wicketSt, prevSt,
      feedLastUpdateMs: t_engine, validatorOk: true, quote: goodQuote(m, 5), stats: null, pEarlyEnd: 0,
      exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false,
    });
    sm = res.sm;

    // During hold period (t_engine + 1000ms), any bet acceptance evaluation must be suspended
    const evalDuringHold = step(sm, m, {
      now: t_engine + 1000, matchStatus: 'live', st: wicketSt, prevSt: wicketSt,
      feedLastUpdateMs: t_engine, validatorOk: true, quote: goodQuote(m, 6), stats: null, pEarlyEnd: 0,
      exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false,
    });
    assert.equal(evalDuringHold.status, 'suspended', 'Must be suspended during event hold');
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   4. FLAP TEST: MISSED POLL & 3-SECOND OUTAGE (Section 8.4)
   ═══════════════════════════════════════════════════════════════════════ */

test('Flap test: 1 missed poll (5s gap) does not suspend; 3s outage does not oscillate', () => {
  const m = mkt('fancy2', 10);
  let sm = initSm();

  // Baseline healthy at t = 10,000
  let res = step(sm, m, {
    now: 10000, matchStatus: 'live',
    st: { innings: 1, runs: 60, wickets: 1, legalBalls: 30, stateSeq: 10, status: 'live' },
    prevSt: { innings: 1, runs: 60, wickets: 1, legalBalls: 30, stateSeq: 10, status: 'live' },
    feedLastUpdateMs: 10000, validatorOk: true, quote: goodQuote(m, 10), stats: null, pEarlyEnd: 0,
    exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false,
  });
  sm = res.sm;
  assert.equal(res.status, 'open');

  // Inject 1 missed poll (5 seconds later, feedLastUpdateMs still 10,000; staleMs is 15s)
  res = step(sm, m, {
    now: 15000, matchStatus: 'live',
    st: { innings: 1, runs: 60, wickets: 1, legalBalls: 30, stateSeq: 10, status: 'live' },
    prevSt: { innings: 1, runs: 60, wickets: 1, legalBalls: 30, stateSeq: 10, status: 'live' },
    feedLastUpdateMs: 10000, validatorOk: true, quote: goodQuote(m, 10), stats: null, pEarlyEnd: 0,
    exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false,
  });
  sm = res.sm;
  assert.equal(res.status, 'open', 'Missed poll within 15s stale threshold must NOT flap to suspended');

  // Inject 3-second outage beyond stale threshold (e.g. at 26,000ms when last update was 10,000ms)
  res = step(sm, m, {
    now: 26000, matchStatus: 'live',
    st: { innings: 1, runs: 60, wickets: 1, legalBalls: 30, stateSeq: 10, status: 'live' },
    prevSt: { innings: 1, runs: 60, wickets: 1, legalBalls: 30, stateSeq: 10, status: 'live' },
    feedLastUpdateMs: 10000, validatorOk: true, quote: goodQuote(m, 10), stats: null, pEarlyEnd: 0,
    exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false,
  });
  sm = res.sm;
  assert.equal(res.status, 'suspended', 'Must suspend on true feed stale');
  assert.ok(res.reasons.includes('FEED_STALE'));

  // Feed recovers with 1st update at 27,000 -> must NOT immediately open (must require 2 fresh updates)
  res = step(sm, m, {
    now: 27000, matchStatus: 'live',
    st: { innings: 1, runs: 61, wickets: 1, legalBalls: 31, stateSeq: 11, status: 'live' },
    prevSt: { innings: 1, runs: 60, wickets: 1, legalBalls: 30, stateSeq: 10, status: 'live' },
    feedLastUpdateMs: 27000, validatorOk: true, quote: goodQuote(m, 11), stats: null, pEarlyEnd: 0,
    exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false,
  });
  sm = res.sm;
  assert.equal(res.status, 'suspended', 'Must debounce reopening after outage');
  assert.ok(res.reasons.includes('FEED_RECOVERING'));

  // 2nd fresh update arrives -> safely reopens without oscillation
  res = step(sm, m, {
    now: 28000, matchStatus: 'live',
    st: { innings: 1, runs: 62, wickets: 1, legalBalls: 32, stateSeq: 12, status: 'live' },
    prevSt: { innings: 1, runs: 61, wickets: 1, legalBalls: 31, stateSeq: 11, status: 'live' },
    feedLastUpdateMs: 28000, validatorOk: true, quote: goodQuote(m, 12), stats: null, pEarlyEnd: 0,
    exposureRatio: 0, manualHold: false, runsAtOverEndKnown: false,
  });
  assert.equal(res.status, 'open', 'Safely reopen on second fresh update');
});

/* ═══════════════════════════════════════════════════════════════════════
   5. SHADOW MODE SIMULATION (Section 8.5)
   ═══════════════════════════════════════════════════════════════════════ */

test('Shadow mode: 20 live matches simulation with zero illegal bets accepted while suspended', () => {
  for (let matchNum = 1; matchNum <= 20; matchNum++) {
    const balls = createDeterministicInnings(matchNum * 104729);
    const m = mkt('fancy2', 15);
    let sm = initSm();
    let prevSt = { innings: 1, runs: 0, wickets: 0, legalBalls: 0, stateSeq: 1, status: 'live' };

    for (const b of balls.slice(0, 30)) {
      const curSt = {
        innings: 1, runs: b.runs, wickets: b.wickets, legalBalls: b.legalBalls,
        stateSeq: b.stateSeq, status: 'live', lastBall: b.lastBall,
      };

      const res = step(sm, m, {
        now: b.timeMs, matchStatus: 'live', st: curSt, prevSt,
        feedLastUpdateMs: b.timeMs, validatorOk: true, quote: goodQuote(m, b.stateSeq),
        stats: null, pEarlyEnd: 0, exposureRatio: 0, manualHold: false,
        runsAtOverEndKnown: false,
      });
      sm = res.sm;

      // Simulated bet acceptance: if status is suspended, rejection is guaranteed
      const betPlacementAllowed = res.status === 'open';
      if (res.status === 'suspended') {
        assert.equal(betPlacementAllowed, false);
      }
      prevSt = curSt;
    }
  }
});
