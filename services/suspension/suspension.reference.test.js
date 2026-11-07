import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ballsToDecision, isStale, distStats, decidedProbability, detectEvents, step, initSm,
  worstCaseLiability, DEFAULT_CONFIG as C,
} from './suspension.reference.js';

const mkt = (type = 'fancy2', overN = 10, innings = 1) => ({ id: 'm1', type, overN, innings });
const st = (o = {}) => ({ innings: 1, runs: 80, wickets: 2, legalBalls: 30, stateSeq: 1, status: 'live', ...o });
const goodQuote = (market, seq = 1) =>
  market.type === 'lastfigure' ? { stateSeq: seq, odds: Array(10).fill(8.85) }
  : market.type === 'evenodd' ? { stateSeq: seq, backOdd: 1.98, layOdd: 2.02, backEven: 1.98, layEven: 2.02 }
  : { stateSeq: seq, yesLine: 13, noLine: 12 };
const ctx = (market, o = {}) => ({
  now: 100000, matchStatus: 'live', st: st(), prevSt: st(), feedLastUpdateMs: 99000, validatorOk: true,
  quote: goodQuote(market), stats: null, pEarlyEnd: 0, exposureRatio: 0, manualHold: false,
  runsAtOverEndKnown: false, ...o,
});

test('ballsToDecision', () => {
  assert.equal(ballsToDecision(mkt('fancy2', 10), st({ legalBalls: 56 })), 4);       // 9.2 -> 4 balls left
  assert.equal(ballsToDecision(mkt('fancy2', 10), st({ legalBalls: 60 })), 0);
  assert.equal(ballsToDecision(mkt('fancy2', 10, 2), st()), Infinity);
  assert.equal(ballsToDecision(mkt('fancy2', 10, 1), st({ innings: 2 })), 0);
});

test('not live (screenshot case) suspends everything', () => {
  for (const t of ['line', 'fancy2', 'evenodd', 'lastfigure']) {
    const m = mkt(t); const r = step(initSm(), m, ctx(m, { matchStatus: 'pre' }));
    assert.equal(r.status, 'suspended'); assert.ok(r.reasons.includes('NOT_LIVE'));
  }
});

test('healthy market opens', () => {
  const m = mkt('fancy2'); const r = step(initSm(), m, ctx(m));
  assert.equal(r.status, 'open'); assert.deepEqual(r.reasons, []);
});

test('end zone: suspended at 3 balls left, open at 4', () => {
  const m = mkt('lastfigure', 10);
  assert.ok(step(initSm(), m, ctx(m, { st: st({ legalBalls: 57 }), prevSt: st({ legalBalls: 57 }) })).reasons.includes('END_ZONE'));
  assert.equal(step(initSm(), m, ctx(m, { st: st({ legalBalls: 56 }), prevSt: st({ legalBalls: 56 }) })).status, 'open');
});

test('stale feed suspends; reopen needs 2 fresh updates', () => {
  const m = mkt('evenodd'); let sm = initSm();
  let r = step(sm, m, ctx(m, { now: 200000, feedLastUpdateMs: 100000 })); sm = r.sm;
  assert.ok(r.reasons.includes('FEED_STALE'));
  r = step(sm, m, ctx(m, { now: 201000, feedLastUpdateMs: 201000, st: st({ stateSeq: 2 }), prevSt: st({ stateSeq: 1 }), quote: goodQuote(m, 2) })); sm = r.sm;
  assert.ok(r.reasons.includes('FEED_RECOVERING'));
  r = step(sm, m, ctx(m, { now: 203000, feedLastUpdateMs: 203000, st: st({ stateSeq: 3 }), prevSt: st({ stateSeq: 2 }), quote: goodQuote(m, 3) }));
  assert.equal(r.status, 'open');
});

test('wicket hold clears only after min hold AND quote seq >= hold seq', () => {
  const m = mkt('fancy2'); let sm = initSm();
  const prev = st({ stateSeq: 5, wickets: 2 }), cur = st({ stateSeq: 6, wickets: 3 });
  let r = step(sm, m, ctx(m, { now: 100000, prevSt: prev, st: cur, quote: goodQuote(m, 5), feedLastUpdateMs: 100000 })); sm = r.sm;
  assert.ok(r.reasons.includes('EVENT_HOLD'));                                          // detected, quote old
  r = step(sm, m, ctx(m, { now: 100500, prevSt: cur, st: cur, quote: goodQuote(m, 6), feedLastUpdateMs: 100500 })); sm = r.sm;
  assert.ok(r.reasons.includes('EVENT_HOLD'));                                          // repriced but min hold (2000ms) not elapsed
  r = step(sm, m, ctx(m, { now: 102100, prevSt: cur, st: cur, quote: goodQuote(m, 6), feedLastUpdateMs: 102100 }));
  assert.equal(r.status, 'open');
});

test('over end and no-ball events', () => {
  assert.deepEqual(detectEvents(st({ stateSeq: 1, legalBalls: 35 }), st({ stateSeq: 2, legalBalls: 36 })), ['overEnd']);
  assert.ok(detectEvents(st({ stateSeq: 1 }), st({ stateSeq: 2, lastBall: { extra: 'noball' } })).includes('noball'));
  assert.deepEqual(detectEvents(st({ stateSeq: 1 }), st({ stateSeq: 1, wickets: 9 })), []);
});

test('decided probability suspends', () => {
  const m = mkt('evenodd'); const samples = new Uint16Array(1000).fill(101); samples[0] = 100;       // ~all odd
  const stats = distStats(samples);
  assert.ok(step(initSm(), m, ctx(m, { stats })).reasons.includes('DECIDED'));
});

test('distStats basics', () => {
  const s = distStats(Array.from({ length: 1000 }, (_, i) => i % 100));
  assert.ok(Math.abs(s.pOdd - 0.5) < 1e-9); assert.ok(s.pDigit.every((p) => Math.abs(p - 0.1) < 1e-9));
  assert.equal(s.pLess(50), 0.5); assert.equal(s.pAtLeast(50), 0.5); assert.equal(s.pLess(0), 0); assert.equal(s.pLess(999), 1);
});

test('early end risk suspends', () => {
  const m = mkt('fancy2'); assert.ok(step(initSm(), m, ctx(m, { pEarlyEnd: 0.45 })).reasons.includes('EARLY_END_RISK'));
});

test('exposure hysteresis', () => {
  const m = mkt('fancy2'); let sm = initSm();
  let r = step(sm, m, ctx(m, { exposureRatio: 1.05 })); sm = r.sm; assert.ok(r.reasons.includes('EXPOSURE'));
  r = step(sm, m, ctx(m, { exposureRatio: 0.9 })); sm = r.sm; assert.ok(r.reasons.includes('EXPOSURE'));   // still latched
  r = step(sm, m, ctx(m, { exposureRatio: 0.7 })); assert.equal(r.status, 'open');
});

test('awaiting settlement is sticky and innings change keeps market suspended', () => {
  const m = mkt('fancy2', 10); let sm = initSm();
  let r = step(sm, m, ctx(m, { st: st({ legalBalls: 60 }), prevSt: st({ legalBalls: 60 }), runsAtOverEndKnown: true })); sm = r.sm;
  assert.ok(r.reasons.includes('AWAITING_SETTLEMENT'));
  r = step(sm, m, ctx(m, { st: st({ innings: 2, legalBalls: 3 }), prevSt: st({ legalBalls: 60 }) }));
  assert.ok(r.reasons.includes('AWAITING_SETTLEMENT'));
});

test('manual hold wins and invalid quote suspends', () => {
  const m = mkt('lastfigure');
  assert.equal(step(initSm(), m, ctx(m, { manualHold: true })).reasons[0], 'MANUAL');
  assert.ok(step(initSm(), m, ctx(m, { quote: { stateSeq: 1, odds: [8.85] } })).reasons.includes('QUOTE_INVALID'));
  const f = mkt('fancy2'); assert.ok(step(initSm(), f, ctx(f, { quote: { stateSeq: 1, yesLine: 12, noLine: 13 } })).reasons.includes('QUOTE_INVALID'));
});

test('worstCaseLiability: last figure', () => {
  const bets = [{ digit: 3, stake: 100 }, { digit: 7, stake: 100 }];
  const settle = (b, d) => (b.digit === d ? b.stake * (8.85 - 1) : -b.stake);
  const { liability, worstOutcome } = worstCaseLiability(bets, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], settle);
  assert.equal(Math.round(liability * 100) / 100, 685); assert.ok([3, 7].includes(worstOutcome));
});

test('worstCaseLiability: fancy yes/no at the line', () => {
  const settle = (b, x) => ((b.side === 'yes') === (x >= b.line) ? (b.stake * b.rate) / 100 : -b.stake);
  const outs = Array.from({ length: 60 }, (_, i) => i);
  const balanced = [{ side: 'yes', line: 13, stake: 100, rate: 100 }, { side: 'no', line: 12, stake: 100, rate: 100 }];
  assert.equal(worstCaseLiability(balanced, outs, settle).liability, 0);              // spread: house never loses; at 12 both lose
  const oneSided = [{ side: 'yes', line: 13, stake: 100, rate: 90 }];
  const w = worstCaseLiability(oneSided, outs, settle);
  assert.equal(w.liability, 90); assert.ok(w.worstOutcome >= 13);
});

test('isStale boundary', () => { assert.equal(isStale(15000, 0, C.staleMs), false); assert.equal(isStale(15001, 0, C.staleMs), true); });
