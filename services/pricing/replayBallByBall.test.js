import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from './odds-calc.reference.js';

const T20 = O.FORMATS.T20;

test('4. Replay test: feed recorded innings ball by ball; every quote is 100% reproducible from seed/stateSeq', () => {
  // 1. Simulate an actual match ball by ball to produce a ground-truth scorecard feed
  const ballFeed = [];
  let runs = 0;
  let wickets = 0;
  const matchRng = O.rng(98765);

  for (let ball = 1; ball <= 60; ball++) {
    const u = matchRng();
    if (u < 0.35) {
      // dot
    } else if (u < 0.70) {
      runs += 1;
    } else if (u < 0.82) {
      runs += 2;
    } else if (u < 0.90) {
      runs += 4;
    } else if (u < 0.95) {
      runs += 6;
    } else {
      wickets = Math.min(wickets + 1, 9);
    }

    ballFeed.push({
      stateSeq: ball,
      seed: ball * 1337 + 101, // deterministic seed derived from stateSeq
      runs,
      wickets,
      legalBalls: ball,
      target: null,
    });
  }

  // 2. Generate quotes on the first pass (e.g. Live match engine run)
  const recordedQuotes = [];

  for (const event of ballFeed) {
    const st = {
      runs: event.runs,
      wickets: event.wickets,
      legalBalls: event.legalBalls,
      target: event.target,
    };

    // Calculate Fancy 2 for 10 Over Run
    const sim10 = O.simulate(st, T20, { kind: 'runsAtOver', overN: 10 }, {
      nSims: 1000,
      seed: event.seed,
    });
    const stats10 = O.distStats(sim10.samples);
    const fancySpreadQuote = O.fancySpread(stats10, { margin: 0.02, bufferRuns: 1 });
    const fancySameLineQuote = O.fancySameLine(stats10, { fancyMargin: 0.02 });

    // Calculate Even/Odd for 15 Over Run
    const sim15 = O.simulate(st, T20, { kind: 'runsAtOver', overN: 15 }, {
      nSims: 1000,
      seed: event.seed + 1,
    });
    const stats15 = O.distStats(sim15.samples);
    const evenOddQuote = O.evenOdd(stats15, { margin: 0.01 });

    // Calculate Last Figure
    const lastFigureQuote = O.lastFigure(stats15, { margin: 0.115 });

    // Calculate Line Ladder
    const lineLadderQuote = O.lineLadder(stats10, { margin: 0.02, bufferRuns: 1 });

    recordedQuotes.push({
      stateSeq: event.stateSeq,
      seed: event.seed,
      fancySpread: fancySpreadQuote,
      fancySameLine: fancySameLineQuote,
      evenOdd: evenOddQuote,
      lastFigure: lastFigureQuote,
      lineLadder: lineLadderQuote,
      mean10: stats10.mean,
      mean15: stats15.mean,
    });
  }

  assert.equal(recordedQuotes.length, 60, 'Recorded 60 ball-by-ball quotes');

  // 3. Replay Pass: Feed the stored seed and stateSeq, assert 100% bit-for-bit identity
  for (let i = 0; i < ballFeed.length; i++) {
    const event = ballFeed[i];
    const rec = recordedQuotes[i];

    const st = {
      runs: event.runs,
      wickets: event.wickets,
      legalBalls: event.legalBalls,
      target: event.target,
    };

    const sim10 = O.simulate(st, T20, { kind: 'runsAtOver', overN: 10 }, {
      nSims: 1000,
      seed: event.seed,
    });
    const stats10 = O.distStats(sim10.samples);
    const replayedSpread = O.fancySpread(stats10, { margin: 0.02, bufferRuns: 1 });
    const replayedSameLine = O.fancySameLine(stats10, { fancyMargin: 0.02 });

    const sim15 = O.simulate(st, T20, { kind: 'runsAtOver', overN: 15 }, {
      nSims: 1000,
      seed: event.seed + 1,
    });
    const stats15 = O.distStats(sim15.samples);
    const replayedEvenOdd = O.evenOdd(stats15, { margin: 0.01 });
    const replayedLastFigure = O.lastFigure(stats15, { margin: 0.115 });
    const replayedLineLadder = O.lineLadder(stats10, { margin: 0.02, bufferRuns: 1 });

    // Assert exact equality of all quoted numbers and lines
    assert.deepEqual(replayedSpread, rec.fancySpread, `Ball ${event.stateSeq} fancySpread must match exactly`);
    assert.deepEqual(replayedSameLine, rec.fancySameLine, `Ball ${event.stateSeq} fancySameLine must match exactly`);
    assert.deepEqual(replayedEvenOdd, rec.evenOdd, `Ball ${event.stateSeq} evenOdd must match exactly`);
    assert.deepEqual(replayedLastFigure, rec.lastFigure, `Ball ${event.stateSeq} lastFigure must match exactly`);
    assert.deepEqual(replayedLineLadder, rec.lineLadder, `Ball ${event.stateSeq} lineLadder must match exactly`);
    assert.equal(stats10.mean, rec.mean10, `Ball ${event.stateSeq} mean10 must match exactly`);
    assert.equal(stats15.mean, rec.mean15, `Ball ${event.stateSeq} mean15 must match exactly`);
  }
});
