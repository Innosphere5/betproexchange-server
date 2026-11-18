import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from './odds-calc.reference.js';

const T20 = O.FORMATS.T20, TEST = O.FORMATS.TEST;
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol})`);
const fresh = { runs: 0, wickets: 0, legalBalls: 0, target: null };

test('ballTable: probabilities sum to 1 and expected runs per legal ball = rpo/6', () => {
  for (const rpo of [3.0, 5.0, 7.4, 9.6]) {
    const t = O.ballTable(rpo, 0.04);
    close(Object.values(t.p).reduce((a, v) => a + v, 0), 1, 1e-12);
    close(O.expectedRunsPerLegal(t), rpo / 6, 1e-9);
    assert.ok(t.p.dot >= 0);
  }
});

test('simulate is deterministic per seed and differs across seeds', () => {
  const a = O.simulate(fresh, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 2000, seed: 5 });
  const b = O.simulate(fresh, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 2000, seed: 5 });
  const c = O.simulate(fresh, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 2000, seed: 6 });
  assert.deepEqual([...a.samples], [...b.samples]);
  assert.notDeepEqual([...a.samples].slice(0, 50), [...c.samples].slice(0, 50));
});

test('sanity: T20 10-over mean and Test 10-over mean are in plausible ranges', () => {
  const t = O.distStats(O.simulate(fresh, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 6000 }).samples).mean;
  const x = O.distStats(O.simulate(fresh, TEST, { kind: 'runsAtOver', overN: 10 }, { nSims: 6000 }).samples).mean;
  assert.ok(t > 60 && t < 78, `T20 mean ${t}`);
  assert.ok(x > 24 && x < 31, `Test mean ${x}`);
  assert.ok(t > 2 * x);
});

test('state sensitivity: more runs raise the projection, wickets lower it', () => {
  const m = (st) => O.distStats(O.simulate(st, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 6000, seed: 3 }).samples).mean;
  const a = m({ runs: 20, wickets: 0, legalBalls: 24, target: null });
  const b = m({ runs: 40, wickets: 0, legalBalls: 24, target: null });
  const c = m({ runs: 40, wickets: 3, legalBalls: 24, target: null });
  assert.ok(b > a + 15);
  assert.ok(c < b - 3);
});

test('liveLambda: fast start tilts up, slow start tilts down, bounded', () => {
  assert.ok(O.liveLambda(T20, { runs: 60, legalBalls: 36 }) > 1);
  assert.ok(O.liveLambda(T20, { runs: 10, legalBalls: 36 }) < 1);
  assert.equal(O.liveLambda(T20, { runs: 0, legalBalls: 0 }), 1);
  assert.ok(O.liveLambda(T20, { runs: 500, legalBalls: 30 }) <= 1.6);
});

test('fancySpread: ordering, probability conditions, gap', () => {
  const s = O.distStats(O.simulate({ runs: 30, wickets: 1, legalBalls: 30, target: null }, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 8000 }).samples);
  const f = O.fancySpread(s, { margin: 0.02 });
  assert.ok(f.noLine <= f.yesLine);
  assert.ok(s.pAtLeast(f.yesLine) <= 0.48 + 1e-9);
  assert.ok(s.pLess(f.noLine) <= 0.48 + 1e-9);
  close(f.gapProb, s.pLess(f.yesLine) - s.pLess(f.noLine), 1e-12);
  const wide = O.fancySpread(s, { margin: 0.02, bufferRuns: 3 });
  assert.ok(wide.yesLine - wide.noLine > f.yesLine - f.noLine);
});

test('rate conversions and the bpexch-style 90/110 quote', () => {
  close(O.rateToProb(90), 0.5263, 1e-4);
  close(O.rateToProb(110), 0.4762, 1e-4);
  assert.equal(O.rateToDecimal(98), 1.98);
  const samples = [...Array(5263).fill(28), ...Array(4737).fill(20)], s = O.distStats(samples);
  const r = O.rateForLine(s, 28, { margin: 0.0025, rounding: 'nearest' });
  assert.equal(r.rateYes, 90);
  assert.equal(r.rateNo, 110);
  const fl = O.rateForLine(s, 28, { margin: 0.02, rounding: 'floor' });
  assert.ok(fl.rateYes <= 90 && fl.rateNo <= 110 && fl.rateYes % 5 === 0);
});

test('skewRates moves rates away from the heavy side and is capped', () => {
  const a = O.skewRates(100, 100, 5000, 0, 10000, { maxSkew: 10 });
  assert.ok(a.rateYes < 100 && a.rateNo >= 100 && a.skew === 5);
  const b = O.skewRates(100, 100, 50000, 0, 10000, { maxSkew: 10 });
  assert.equal(b.skew, 10);
  assert.equal(O.skewRates(100, 100, 100, 100, 1000).skew, 0);
});

test('evenOdd: p=0.5, m=0.01 gives 1.98/2.02 and rates 98/102', () => {
  const s = O.distStats([...Array(500).fill(1), ...Array(500).fill(2)]);
  const q = O.evenOdd(s, { margin: 0.01 });
  assert.equal(q.odd.back, 1.98);
  assert.equal(q.odd.lay, 2.02);
  assert.equal(q.odd.rateBack, 98);
  assert.equal(q.odd.rateLay, 102);
});

test('lastFigure: uniform digits with m=0.115 give 8.85; fixed table; overround', () => {
  const s = O.distStats(Array.from({ length: 1000 }, (_, i) => i % 10));
  const q = O.lastFigure(s);
  assert.ok(q.odds.every((o) => o === 8.85));
  close(q.overround, 10 / 8.85, 0.01);
  close(O.lastFigureFixed().overround, 1.1299, 1e-3);
});

test('lastFigure: floor and cap stop absurd prices on impossible digits', () => {
  const s = O.distStats(Array(1000).fill(103));
  const q = O.lastFigure(s, { oddsMax: 20 });
  assert.ok(q.odds.every((o) => o <= 20 && o >= 1.01));
  assert.equal(q.odds[0], 20); // impossible digit hits the cap; certain digit stays >= 1.01
});

test('lineLadder: over levels sit above under levels, one run apart', () => {
  const s = O.distStats(O.simulate(fresh, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 4000 }).samples);
  const l = O.lineLadder(s);
  assert.ok(Math.min(...l.over) > Math.max(...l.under));
  assert.equal(l.over[1] - l.over[0], 1);
  assert.equal(l.under[0] - l.under[1], 1);
});

test('runsInOver window and runsAtWicket specs', () => {
  const w = O.distStats(O.simulate(fresh, T20, { kind: 'runsInOver', overN: 8 }, { nSims: 6000 }).samples);
  assert.ok(w.mean > 5 && w.mean < 10, `${w.mean}`);
  const f = O.distStats(O.simulate(fresh, T20, { kind: 'runsAtWicket', n: 1 }, { nSims: 6000 }).samples);
  assert.ok(f.mean > 15 && f.mean < 50, `${f.mean}`);
  assert.throws(() => O.simulate({ runs: 5, wickets: 1, legalBalls: 8, target: null }, T20, { kind: 'runsAtWicket', n: 1 }));
  assert.throws(() => O.simulate({ runs: 5, wickets: 0, legalBalls: 50, target: null }, T20, { kind: 'runsInOver', overN: 8 }));
});

test('pEarlyEnd rises when the innings can end before the target over', () => {
  const lo = O.simulate({ runs: 30, wickets: 2, legalBalls: 30, target: null }, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 4000 }).pEarlyEnd;
  const hi = O.simulate({ runs: 30, wickets: 9, legalBalls: 30, target: null }, T20, { kind: 'runsAtOver', overN: 10 }, { nSims: 4000 }).pEarlyEnd;
  assert.ok(hi > lo + 0.2);
});

test('brier and reliability', () => {
  assert.equal(O.brier([1, 0, 1], [1, 0, 1]), 0);
  close(O.brier([0.5, 0.5], [1, 0]), 0.25, 1e-12);
  const rel = O.reliability([0.1, 0.12, 0.9, 0.95], [0, 0, 1, 1], 10);
  assert.equal(rel[1].n, 2);
  assert.equal(rel[9].observed, 1);
});
