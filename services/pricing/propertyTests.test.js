import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from './odds-calc.reference.js';

const T20 = O.FORMATS.T20;
const ODI = O.FORMATS.ODI;
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol})`);

test('5. Property tests: mathematical invariants hold across diverse match states', () => {
  const r = O.rng(54321);

  // Generate 50 varied states across T20 and ODI
  for (let trial = 0; trial < 50; trial++) {
    const isT20 = r() > 0.5;
    const fmt = isT20 ? T20 : ODI;
    const maxOver = isT20 ? 20 : 50;

    // Pick random target over between 5 and maxOver
    const targetOver = 5 + Math.floor(r() * (maxOver - 5));
    const currentBalls = Math.floor(r() * (targetOver * 6 - 6)); // ensure before target over
    const currentRuns = Math.floor(currentBalls * (0.8 + r() * 1.5));
    const currentWickets = Math.min(Math.floor(r() * 8), 9);

    const st = {
      runs: currentRuns,
      wickets: currentWickets,
      legalBalls: currentBalls,
      target: null,
    };

    const sim = O.simulate(st, fmt, { kind: 'runsAtOver', overN: targetOver }, {
      nSims: 1000,
      seed: trial * 77 + 1,
    });
    const stats = O.distStats(sim.samples);
    if (!stats) continue;

    // Invariant 1: Digit probabilities sum to 1
    const digitSum = stats.pDigit.reduce((acc, p) => acc + p, 0);
    close(digitSum, 1, 1e-12);

    // Invariant 2: Parity probabilities sum to 1
    close(stats.pOdd + stats.pEven, 1, 1e-12);

    // Invariant 3: Fancy spread ordering noLine <= yesLine and gapProb >= 0
    for (const margin of [0.01, 0.02, 0.03]) {
      for (const bufferRuns of [0, 1, 2, 4]) {
        const spread = O.fancySpread(stats, { margin, bufferRuns });
        assert.ok(
          spread.noLine <= spread.yesLine,
          `noLine (${spread.noLine}) must be <= yesLine (${spread.yesLine}) at trial ${trial}`
        );
        assert.ok(
          spread.gapProb >= -1e-12,
          `gapProb (${spread.gapProb}) must be non-negative at trial ${trial}`
        );
      }
    }

    // Invariant 4: Even/Odd odds are >= 1.01 and Back <= Lay
    const eo = O.evenOdd(stats);
    assert.ok(eo.odd.back >= 1.01, `odd.back ${eo.odd.back} >= 1.01`);
    assert.ok(eo.odd.lay >= 1.01, `odd.lay ${eo.odd.lay} >= 1.01`);
    assert.ok(eo.even.back >= 1.01, `even.back ${eo.even.back} >= 1.01`);
    assert.ok(eo.even.lay >= 1.01, `even.lay ${eo.even.lay} >= 1.01`);

    assert.ok(eo.odd.back <= eo.odd.lay, `odd.back (${eo.odd.back}) <= odd.lay (${eo.odd.lay})`);
    assert.ok(eo.even.back <= eo.even.lay, `even.back (${eo.even.back}) <= even.lay (${eo.even.lay})`);

    // Invariant 5: Last Figure odds are all >= 1.01
    const lfDynamic = O.lastFigure(stats, { oddsMax: 20 });
    for (let d = 0; d < 10; d++) {
      assert.ok(lfDynamic.odds[d] >= 1.01, `lfDynamic.odds[${d}] (${lfDynamic.odds[d]}) >= 1.01`);
      assert.ok(lfDynamic.odds[d] <= 20, `lfDynamic.odds[${d}] (${lfDynamic.odds[d]}) <= 20`);
    }

    // Invariant 6: Same-line mode rates stay strictly within [rateMin, rateMax] if found
    const sameLine = O.fancySameLine(stats, { rateMin: 70, rateMax: 130, rateStep: 5 });
    if (sameLine) {
      assert.ok(sameLine.rateYes >= 70 && sameLine.rateYes <= 130, `rateYes ${sameLine.rateYes} in [70, 130]`);
      assert.ok(sameLine.rateNo >= 70 && sameLine.rateNo <= 130, `rateNo ${sameLine.rateNo} in [70, 130]`);
      assert.equal(sameLine.rateYes % 5, 0, `rateYes must be multiple of 5`);
      assert.equal(sameLine.rateNo % 5, 0, `rateNo must be multiple of 5`);
    }

    // Invariant 7: Line Ladder: over levels strictly above under levels
    const ladder = O.lineLadder(stats);
    assert.ok(
      Math.min(...ladder.over) > Math.max(...ladder.under),
      'Ladder over levels must be strictly above under levels'
    );
  }
});
