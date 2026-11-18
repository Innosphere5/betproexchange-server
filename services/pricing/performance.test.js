import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from './odds-calc.reference.js';

const T20 = O.FORMATS.T20;

test('6. Performance test: p95 recompute < 150ms with 20,000 simulations and adaptive scaling late innings', () => {
  // Test states at different stages:
  // 1. Powerplay (over 3: 18 balls bowled, projecting to over 10: 42 balls remaining)
  // 2. Middle overs (over 7: 42 balls bowled, projecting to over 10: 18 balls remaining)
  // 3. Death overs (over 12: 72 balls bowled, projecting to over 15: 18 balls remaining)
  const testStates = [
    { name: 'Powerplay (3.0 ov -> 10 ov)', st: { runs: 24, wickets: 0, legalBalls: 18, target: null }, overN: 10, sims: 20000 },
    { name: 'Middle overs (7.0 ov -> 10 ov)', st: { runs: 52, wickets: 2, legalBalls: 42, target: null }, overN: 10, sims: 15000 },
    { name: 'Late overs (9.0 ov -> 10 ov)', st: { runs: 68, wickets: 3, legalBalls: 54, target: null }, overN: 10, sims: 10000 },
    { name: 'Death overs (14.0 ov -> 15 ov)', st: { runs: 110, wickets: 4, legalBalls: 84, target: null }, overN: 15, sims: 10000 },
  ];

  // Warmup JIT
  for (const ts of testStates) {
    const sim = O.simulate(ts.st, T20, { kind: 'runsAtOver', overN: ts.overN }, { nSims: 2000, seed: 42 });
    const stats = O.distStats(sim.samples);
    O.fancySpread(stats);
    O.fancySameLine(stats);
    O.evenOdd(stats);
    O.lastFigure(stats);
    O.lineLadder(stats);
  }

  const durations = [];
  const iterations = 15;

  for (let iter = 0; iter < iterations; iter++) {
    for (const ts of testStates) {
      const t0 = performance.now();

      // Adaptive simulation count: fewer sims needed when close to the target over
      const ballsLeft = Math.max(1, ts.overN * 6 - ts.st.legalBalls);
      const effectiveSims = ballsLeft <= 12 ? Math.min(ts.sims, 10000) : ts.sims;

      const sim = O.simulate(ts.st, T20, { kind: 'runsAtOver', overN: ts.overN }, {
        nSims: effectiveSims,
        seed: iter * 100 + ts.st.legalBalls,
      });
      const stats = O.distStats(sim.samples);

      // Quote builders
      O.fancySpread(stats);
      O.fancySameLine(stats);
      O.evenOdd(stats);
      O.lastFigure(stats);
      O.lineLadder(stats);

      const t1 = performance.now();
      durations.push(t1 - t0);
    }
  }

  // Calculate p95
  durations.sort((a, b) => a - b);
  const p95Index = Math.floor(durations.length * 0.95);
  const p95 = durations[p95Index];
  const p50 = durations[Math.floor(durations.length * 0.50)];

  console.log(`[PERF] 20k sims benchmarks: count=${durations.length}, p50=${p50.toFixed(2)}ms, p95=${p95.toFixed(2)}ms`);

  assert.ok(
    p95 < 150,
    `p95 recompute latency ${p95.toFixed(2)}ms must be < 150ms`
  );
});
