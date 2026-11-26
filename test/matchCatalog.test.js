const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SLIM_CATALOG_PROJECTION,
  deduplicateMatches,
  sortCatalogMatches,
} = require('../services/matchCatalogService');

test('SLIM_CATALOG_PROJECTION excludes nested per-market arrays', () => {
  for (const field of ['-fancyMarkets', '-figureMarkets', '-evenOddMarkets', '-tiedMatchMarket']) {
    assert.ok(SLIM_CATALOG_PROJECTION.includes(field), `Expected ${field} in slim projection`);
  }
});

test('deduplicateMatches prefers live match over duplicate upcoming entry on same date', () => {
  const input = [
    { matchId: 'id1', teamA: 'Dubai Capitals', teamB: 'Desert Vipers', status: 'upcoming', startTime: '2026-11-25T14:30:00.000Z' },
    { matchId: 'id2', teamA: 'Dubai Capitals', teamB: 'Desert Vipers', status: 'live', backOddsA: 1.8, backOddsB: 2.1, startTime: '2026-11-25T14:30:00.000Z' },
  ];
  const deduped = deduplicateMatches(input);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].matchId, 'id2');
  assert.equal(deduped[0].status, 'live');
});

test('sortCatalogMatches always puts live matches before upcoming international matches', () => {
  const input = [
    { matchId: 'id_nz_ind', teamA: 'New Zealand', teamB: 'India', league: 'Test Series New Zealand vs India', status: 'upcoming', startTime: '2026-11-26T22:00:00.000Z' },
    { matchId: 'id_ilt20', teamA: 'Dubai Capitals', teamB: 'Desert Vipers', league: 'International League T20', status: 'live', startTime: '2026-11-25T14:30:00.000Z' },
  ];
  const sorted = sortCatalogMatches(input);
  assert.equal(sorted[0].matchId, 'id_ilt20');
  assert.equal(sorted[0].status, 'live');
});
