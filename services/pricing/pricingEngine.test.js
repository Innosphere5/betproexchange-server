// services/pricing/pricingEngine.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMatchOdds, detectFormat, parseLegalBalls, parseRuns } from './pricingEngine.js';

test('parseLegalBalls converts cricket notation overs correctly', () => {
  assert.equal(parseLegalBalls('0.0'), 0);
  assert.equal(parseLegalBalls('0.1'), 1);
  assert.equal(parseLegalBalls('1.0'), 6);
  assert.equal(parseLegalBalls('9.2'), 56);
  assert.equal(parseLegalBalls('35.1'), 211);
  assert.equal(parseLegalBalls('50.0'), 300);
});

test('parseRuns extracts runs reliably', () => {
  assert.equal(parseRuns(0), 0);
  assert.equal(parseRuns('211/5'), 211);
  assert.equal(parseRuns('80-2'), 80);
  assert.equal(parseRuns({ teamB_runs: '175/3' }), 175);
});

test('detectFormat detects T20, ODI, and TEST accurately', () => {
  assert.equal(detectFormat({ league: 'Indian Premier League T20' }), 'T20');
  assert.equal(detectFormat({ league: 'Australia v England ODI' }), 'ODI');
  assert.equal(detectFormat({ format: 'oneday' }), 'ODI');
  assert.equal(detectFormat({ format: 'test' }), 'TEST');
  assert.equal(detectFormat({ league: 'ICC World Test Championship' }), 'TEST');
});

test('computeMatchOdds computes calibrated odds for live match', () => {
  const liveMatch = {
    matchId: 'test_match_1',
    teamA: 'Australia',
    teamB: 'England',
    league: 'ODI Series',
    status: 'live',
    format: 'oneday',
    score: {
      teamA_runs: '0/0',
      teamB_runs: '211/5',
      overs: '35.1',
      wickets: 5,
      battingTeam: 'teamB',
      battingTeamName: 'England',
      bowlingTeamName: 'Australia',
      target: 0
    }
  };

  const res = computeMatchOdds(liveMatch);
  assert.ok(res);
  assert.equal(res.format, 'ODI');
  assert.equal(res.runs, 211);
  assert.equal(res.wickets, 5);
  assert.equal(res.legalBalls, 211);

  // Check Fancy 2
  assert.ok(res.fancyMarkets.length > 0);
  const openFancy = res.fancyMarkets.filter(f => f.status === 'OPEN');
  assert.ok(openFancy.length > 0, 'Must have active OPEN fancy markets for future overs');

  // Verify spread: yesLine >= noLine and rates are valid numbers
  for (const f of openFancy) {
    assert.ok(f.backPrice >= f.layPrice, `${f.name}: back ${f.backPrice} should be >= lay ${f.layPrice}`);
    assert.equal(f.backVol, '100');
    assert.equal(f.layVol, '100');
  }

  // Check Figure market
  assert.ok(res.figureMarkets.length > 0);
  const fig = res.figureMarkets[0];
  assert.equal(fig.status, 'OPEN');
  assert.equal(fig.digits.length, 10);
  for (const d of fig.digits) {
    assert.ok(d.odds >= 1.01 && d.odds <= 20, `Digit ${d.digit} odds ${d.odds} must be between 1.01 and 20`);
    assert.equal(d.status, 'OPEN');
  }

  // Check Even/Odd market
  assert.ok(res.evenOddMarkets.length > 0);
  const openEO = res.evenOddMarkets.filter(eo => eo.status === 'OPEN');
  assert.ok(openEO.length > 0);
  for (const eo of openEO) {
    assert.ok(eo.backPrice >= 1.01 && eo.backPrice <= 3.0);
    assert.ok(eo.layPrice >= 1.01 && eo.layPrice <= 3.0);
  }
});

test('computeMatchOdds marks markets SUSPENDED when match is not live', () => {
  const upcomingMatch = {
    matchId: 'test_match_2',
    teamA: 'India',
    teamB: 'Pakistan',
    league: 'T20 International',
    status: 'upcoming',
    format: 't20',
    score: {
      teamA_runs: '0/0',
      teamB_runs: '0/0',
      overs: '0.0',
      wickets: 0
    }
  };

  const res = computeMatchOdds(upcomingMatch);
  assert.ok(res);
  // When match is upcoming, markets are SUSPENDED (first-class reason per spec)
  const openFancy = res.fancyMarkets.filter(f => f.status === 'OPEN');
  assert.equal(openFancy.length, 0);

  const openEO = res.evenOddMarkets.filter(eo => eo.status === 'OPEN');
  assert.equal(openEO.length, 0);

  const openFig = res.figureMarkets.filter(fig => fig.status === 'OPEN');
  assert.equal(openFig.length, 0);
});

test('computeMatchOdds determinism: same input gives exact same lines', () => {
  const match = {
    matchId: 'deterministic_test',
    teamA: 'South Africa',
    teamB: 'Bangladesh',
    status: 'live',
    format: 't20',
    score: {
      teamA_runs: '75/2',
      overs: '9.3',
      wickets: 2,
      battingTeam: 'teamA'
    }
  };

  const res1 = computeMatchOdds(match, { stateSeq: 10 });
  const res2 = computeMatchOdds(match, { stateSeq: 10 });

  assert.deepEqual(res1.fancyMarkets, res2.fancyMarkets);
  assert.deepEqual(res1.figureMarkets, res2.figureMarkets);
  assert.deepEqual(res1.evenOddMarkets, res2.evenOddMarkets);
});
