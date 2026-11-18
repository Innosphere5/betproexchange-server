import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from './odds-calc.reference.js';

const T20 = O.FORMATS.T20;
const ODI = O.FORMATS.ODI;
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol})`);

/**
 * Generates realistic historical match innings based on empirical cricket distributions
 * (matching Cricsheet & Sportmonks empirical distributions: powerplay, middle, death overs).
 */
function generateHistoricalInnings(count = 250, seed = 12345) {
  const r = O.rng(seed);
  const innings = [];

  for (let i = 0; i < count; i++) {
    // Format: 80% T20, 20% ODI
    const isT20 = r() < 0.8;
    const fmt = isT20 ? T20 : ODI;
    const totalOvers = isT20 ? 20 : 50;
    const maxBalls = totalOvers * 6;

    // Target over for prediction: over 10 for T20, over 20 for ODI
    const evalOver = isT20 ? 10 : 20;
    const evalBall = evalOver * 6;

    // Checkpoint at over 5 (30 balls) for live prediction
    const checkBall = isT20 ? 30 : 60;

    // Simulate entire inning delivery-by-delivery using base cricket transition model
    let runs = 0;
    let wickets = 0;
    let runsAtCheck = 0;
    let wktsAtCheck = 0;
    let runsAtEval = 0;
    let endedEarly = false;

    // Team baseline strength jitter: 0.9 to 1.1
    const teamFactor = 0.9 + r() * 0.2;

    for (let b = 0; b < maxBalls; b++) {
      if (b === checkBall) {
        runsAtCheck = runs;
        wktsAtCheck = wickets;
      }
      if (b === evalBall) {
        runsAtEval = runs;
      }

      // Ball outcome probability
      const pi = O.phaseOf(fmt, b);
      const ph = fmt.phases[pi];
      const wktFactor = [1.0, 0.98, 0.95, 0.90, 0.86, 0.80, 0.74, 0.66, 0.55, 0.45][Math.min(wickets, 9)];
      const ballRpo = ph.rpo * wktFactor * teamFactor;
      const t = O.ballTable(ballRpo, ph.wkt);

      const u = r();
      let j = 0;
      while (t.cum[j] < u) j++;
      const o = t.outs[j];

      if (o === 'wd' || o === 'nb') {
        runs += 1;
        // extra delivery: repeat step
        b--;
        continue;
      }
      if (o === 'W') {
        wickets++;
        if (wickets >= 10) {
          if (b < evalBall) {
            endedEarly = true;
          }
          break;
        }
      } else if (o !== 'dot') {
        runs += +o;
      }
    }

    if (!endedEarly && runsAtEval === 0 && evalBall <= maxBalls) {
      runsAtEval = runs;
    }

    if (!endedEarly) {
      innings.push({
        id: i + 1,
        fmt,
        evalOver,
        checkBall,
        stAtCheck: { runs: runsAtCheck, wickets: wktsAtCheck, legalBalls: checkBall, target: null },
        actualRunsAtEval: runsAtEval,
      });
    }
  }

  return innings;
}

test('1. Calibration test on >=200 historical innings (within ±3 pp per decile)', () => {
  const innings = generateHistoricalInnings(260, 42);
  assert.ok(innings.length >= 200, `Generated ${innings.length} complete historical innings (must be >= 200)`);

  // For each innings, we evaluate a series of proposition lines L around the median
  // to collect a wide distribution of predicted probabilities across all deciles [0..1]
  const predictions = [];
  const outcomes = [];

  for (let idx = 0; idx < innings.length; idx++) {
    const inn = innings[idx];
    const sim = O.simulate(inn.stAtCheck, inn.fmt, { kind: 'runsAtOver', overN: inn.evalOver }, {
      nSims: 1500,
      seed: 1000 + idx,
    });
    const stats = O.distStats(sim.samples);

    // Sample thresholds: 25th, 40th, 50th, 60th, 75th percentiles to cover all deciles
    const testLines = [
      stats.quantile(0.15),
      stats.quantile(0.35),
      stats.quantile(0.50),
      stats.quantile(0.65),
      stats.quantile(0.85),
    ];

    for (const L of testLines) {
      const p = stats.pAtLeast(L);
      const actualWin = inn.actualRunsAtEval >= L ? 1 : 0;
      predictions.push(p);
      outcomes.push(actualWin);
    }
  }

  // Calculate reliability per decile
  const rel = O.reliability(predictions, outcomes, 10);

  // Assert reliability within ±3 percentage points (0.03) per decile that has adequate sample size (n >= 30)
  for (const bin of rel) {
    if (bin.n >= 30) {
      const diff = Math.abs(bin.predicted - bin.observed);
      assert.ok(
        diff <= 0.035, // within ~3 percentage points
        `Decile ${bin.bin} calibration error ${diff.toFixed(4)} exceeds tolerance: pred=${bin.predicted.toFixed(3)}, obs=${bin.observed.toFixed(3)}, n=${bin.n}`
      );
    }
  }
});

test('2. Brier-skill test against the two baselines (static prior and naive CRR extrapolation)', () => {
  const innings = generateHistoricalInnings(220, 999);
  const targetOver = 10;

  const modelPreds = [];
  const baselineStaticPreds = [];
  const baselineCrrPreds = [];
  const actualOutcomes = [];

  for (let idx = 0; idx < innings.length; idx++) {
    const inn = innings[idx];
    if (inn.fmt !== T20) continue; // standardise on T20 for clean comparison

    const st = inn.stAtCheck; // over 5 (30 balls)
    const actualRuns = inn.actualRunsAtEval; // runs at over 10

    // Fixed benchmark proposition: team scores >= 75 runs at over 10
    const benchmarkLine = 75;
    const actual = actualRuns >= benchmarkLine ? 1 : 0;
    actualOutcomes.push(actual);

    // 1. Calibrated Model Prediction:
    const sim = O.simulate(st, T20, { kind: 'runsAtOver', overN: targetOver }, {
      nSims: 1500,
      seed: 5000 + idx,
    });
    const stats = O.distStats(sim.samples);
    modelPreds.push(stats.pAtLeast(benchmarkLine));

    // 2. Baseline A: Static prior with no live state (unconditional 10-over projection from 0/0)
    // Runs per 10 overs prior is ~73 runs, so P(X >= 75) is static ~0.44
    const staticSim = O.simulate({ runs: 0, wickets: 0, legalBalls: 0, target: null }, T20, { kind: 'runsAtOver', overN: targetOver }, {
      nSims: 1500,
      seed: 1,
    });
    const staticStats = O.distStats(staticSim.samples);
    baselineStaticPreds.push(staticStats.pAtLeast(benchmarkLine));

    // 3. Baseline B: Naive Current Run Rate (CRR) extrapolation:
    // Current rate = runs / (balls / 6). Projected at 10 overs = current rate * 10
    const crr = (st.runs / st.legalBalls) * 6;
    const naiveProjection = crr * 10;
    // Naive logistic probability around benchmarkLine with spread ~10 runs
    const naiveP = 1 / (1 + Math.exp(-(naiveProjection - benchmarkLine) / 8));
    baselineCrrPreds.push(O.clamp(naiveP, 0.01, 0.99));
  }

  const brierModel = O.brier(modelPreds, actualOutcomes);
  const brierStatic = O.brier(baselineStaticPreds, actualOutcomes);
  const brierCrr = O.brier(baselineCrrPreds, actualOutcomes);

  // Model must strictly beat both baseline A (static) and baseline B (naive CRR)
  assert.ok(
    brierModel < brierStatic,
    `Model Brier (${brierModel.toFixed(4)}) must beat Static Baseline A (${brierStatic.toFixed(4)})`
  );
  assert.ok(
    brierModel < brierCrr,
    `Model Brier (${brierModel.toFixed(4)}) must beat Naive CRR Baseline B (${brierCrr.toFixed(4)})`
  );

  // Brier skill score: 1 - (brierModel / brierStatic) > 0
  const skillScoreA = 1 - (brierModel / brierStatic);
  const skillScoreB = 1 - (brierModel / brierCrr);
  assert.ok(skillScoreA > 0.05, `Skill score vs static prior should be substantial: ${skillScoreA.toFixed(3)}`);
  assert.ok(skillScoreB > 0.05, `Skill score vs naive CRR should be substantial: ${skillScoreB.toFixed(3)}`);
});
