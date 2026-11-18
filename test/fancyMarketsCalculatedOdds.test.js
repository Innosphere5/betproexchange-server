// test/fancyMarketsCalculatedOdds.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fancyMarketsService = require('../services/fancyMarketsService');
const pricingEngine = require('../services/pricing/pricingEngine');

test('FancyMarketsService integrates with pricingEngine for calculated odds', async () => {
  const mockMatch = {
    matchId: 'calc_test_100',
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

  const computed = pricingEngine.computeMatchOdds(mockMatch);
  assert.ok(computed, 'Pricing engine should return computed odds');

  // Verify Fancy 2 markets have spread line quotes
  const openFancy = computed.fancyMarkets.filter(f => f.status === 'OPEN');
  assert.ok(openFancy.length >= 1, 'Should have at least 1 open upcoming fancy market');
  for (const f of openFancy) {
    assert.ok(typeof f.backPrice === 'number');
    assert.ok(typeof f.layPrice === 'number');
    assert.ok(f.backPrice >= f.layPrice);
  }

  // Verify Figure market
  assert.equal(computed.figureMarkets.length, 1);
  const fig = computed.figureMarkets[0];
  assert.equal(fig.status, 'OPEN');
  assert.equal(fig.digits.length, 10);
  for (const d of fig.digits) {
    assert.equal(d.status, 'OPEN');
    assert.ok(d.odds >= 1.01);
  }

  // Verify Even/Odd markets
  const openEO = computed.evenOddMarkets.filter(eo => eo.status === 'OPEN');
  assert.ok(openEO.length >= 1);
  for (const eo of openEO) {
    assert.ok(eo.backPrice >= 1.01 && eo.backPrice <= 3.0);
    assert.ok(eo.layPrice >= 1.01 && eo.layPrice <= 3.0);
  }
});

test('extractFancyMarkets falls back to pricingEngine when normalizedOdds is null', () => {
  const match = {
    teamA: 'Australia',
    teamB: 'England',
    status: 'live',
    format: 'oneday',
    score: {
      teamA_runs: '0/0',
      teamB_runs: '120/2',
      overs: '20.0',
      wickets: 2,
      battingTeam: 'teamB',
      battingTeamName: 'England'
    }
  };

  const fancy = fancyMarketsService.extractFancyMarkets(null, match);
  assert.ok(Array.isArray(fancy));
  assert.ok(fancy.length > 0);
  const openItems = fancy.filter(f => f.status === 'OPEN');
  assert.ok(openItems.length > 0, 'Should have OPEN markets calculated from pricingEngine');
});

test('extractFigureMarkets falls back to pricingEngine when normalizedOdds is null', () => {
  const match = {
    teamA: 'Australia',
    teamB: 'England',
    status: 'live',
    format: 'oneday',
    score: {
      teamA_runs: '0/0',
      teamB_runs: '120/2',
      overs: '20.0',
      wickets: 2,
      battingTeam: 'teamB',
      battingTeamName: 'England'
    }
  };

  const figures = fancyMarketsService.extractFigureMarkets(null, match);
  assert.ok(Array.isArray(figures));
  assert.equal(figures.length, 1);
  assert.equal(figures[0].status, 'OPEN');
  assert.equal(figures[0].digits.length, 10);
  assert.ok(figures[0].digits.some(d => d.status === 'OPEN'));
});

test('extractEvenOddMarkets falls back to pricingEngine when normalizedOdds is null', () => {
  const match = {
    teamA: 'Australia',
    teamB: 'England',
    status: 'live',
    format: 'oneday',
    score: {
      teamA_runs: '0/0',
      teamB_runs: '120/2',
      overs: '20.0',
      wickets: 2,
      battingTeam: 'teamB',
      battingTeamName: 'England'
    }
  };

  const eo = fancyMarketsService.extractEvenOddMarkets(null, match);
  assert.ok(Array.isArray(eo));
  assert.ok(eo.length > 0);
  const openItems = eo.filter(m => m.status === 'OPEN');
  assert.ok(openItems.length > 0);
  for (const item of openItems) {
    assert.ok(item.backPrice >= 1.01);
    assert.ok(item.layPrice >= 1.01);
  }
});

