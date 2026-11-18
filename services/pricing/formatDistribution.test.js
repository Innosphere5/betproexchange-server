import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from './odds-calc.reference.js';

const { T20, ODI, TEST } = O.FORMATS;
const fresh = { runs: 0, wickets: 0, legalBalls: 0, target: null };

test('3. Format tests: T20, ODI, and TEST produce different, plausible distributions', () => {
  const nSims = 6000;
  const seed = 777;

  // 1. Evaluate 10-over projections across all three formats from a fresh start (0/0 after 0 balls)
  const t20_10 = O.distStats(O.simulate(fresh, T20, { kind: 'runsAtOver', overN: 10 }, { nSims, seed }).samples);
  const odi_10 = O.distStats(O.simulate(fresh, ODI, { kind: 'runsAtOver', overN: 10 }, { nSims, seed }).samples);
  const test_10 = O.distStats(O.simulate(fresh, TEST, { kind: 'runsAtOver', overN: 10 }, { nSims, seed }).samples);

  // Assert expected 10-over mean hierarchy: T20 > ODI > TEST
  assert.ok(t20_10.mean > odi_10.mean, `T20 mean (${t20_10.mean.toFixed(1)}) must exceed ODI mean (${odi_10.mean.toFixed(1)})`);
  assert.ok(odi_10.mean > test_10.mean, `ODI mean (${odi_10.mean.toFixed(1)}) must exceed TEST mean (${test_10.mean.toFixed(1)})`);

  // Plausible scoring ranges:
  // T20: 10 overs typically ~68 - 76 runs
  assert.ok(t20_10.mean >= 65 && t20_10.mean <= 78, `T20 10-over mean ${t20_10.mean} in [65, 78]`);
  // ODI: 10 overs typically ~48 - 56 runs
  assert.ok(odi_10.mean >= 45 && odi_10.mean <= 58, `ODI 10-over mean ${odi_10.mean} in [45, 58]`);
  // TEST: 10 overs typically ~25 - 33 runs
  assert.ok(test_10.mean >= 24 && test_10.mean <= 34, `TEST 10-over mean ${test_10.mean} in [24, 34]`);

  // 2. Full innings projections:
  // T20 (20 overs)
  const t20_20 = O.distStats(O.simulate(fresh, T20, { kind: 'runsAtOver', overN: 20 }, { nSims, seed }).samples);
  // ODI (50 overs)
  const odi_50 = O.distStats(O.simulate(fresh, ODI, { kind: 'runsAtOver', overN: 50 }, { nSims, seed }).samples);

  assert.ok(t20_20.mean >= 130 && t20_20.mean <= 175, `T20 20-over total ${t20_20.mean} in [130, 175]`);
  assert.ok(odi_50.mean >= 230 && odi_50.mean <= 290, `ODI 50-over total ${odi_50.mean} in [230, 290]`);

  // 3. Fall of Wicket: First wicket partnership expectation across formats
  const t20_w1 = O.distStats(O.simulate(fresh, T20, { kind: 'runsAtWicket', n: 1 }, { nSims, seed }).samples);
  const test_w1 = O.distStats(O.simulate(fresh, TEST, { kind: 'runsAtWicket', n: 1 }, { nSims, seed }).samples);

  // In Test cricket, wickets fall slower on average per ball; partnership expected runs are substantial
  assert.ok(test_w1.mean > t20_w1.mean, `Test 1st wicket mean runs (${test_w1.mean.toFixed(1)}) must exceed T20 (${t20_w1.mean.toFixed(1)})`);

  // 4. Quantile distributions show distinct tails
  const t20_p90 = t20_10.quantile(0.90);
  const odi_p90 = odi_10.quantile(0.90);
  const test_p90 = test_10.quantile(0.90);

  assert.ok(t20_p90 > odi_p90 && odi_p90 > test_p90, '90th percentile runs maintain strict format separation');
});
