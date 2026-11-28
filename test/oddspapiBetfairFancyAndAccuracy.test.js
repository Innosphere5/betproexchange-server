const test = require('node:test');
const assert = require('node:assert/strict');
const {
  selectAccurateMatchOddsMarket,
  extractRunnerDepthFromQuote,
  resolveBetfairFancyMeta,
} = require('../services/oddspapiCricketCatalog');
const fancyMarketsService = require('../services/fancyMarketsService');
const { normalizeCategory } = require('../services/limitService');

test('Oddspapi Match Odds prefers high-liquidity 271 (Winner) over 273 (1X2) for T20/ODI', () => {
  // Real Australia v England Oddspapi structure (both 271 and 273 present)
  const byMarket = {
    '271': [
      {
        marketId: 271,
        outcomeId: 271,
        price: 2.12,
        mainLine: true,
        meta: {
          availableToBack: [{ price: 2.12, size: 2135.28 }, { price: 2.10, size: 548.56 }, { price: 2.08, size: 597.27 }],
          availableToLay: [{ price: 2.16, size: 1042.84 }, { price: 2.18, size: 4592.99 }, { price: 2.20, size: 1649.24 }],
        },
      },
      {
        marketId: 271,
        outcomeId: 272,
        price: 1.87,
        mainLine: true,
        meta: {
          availableToBack: [{ price: 1.87, size: 1074.21 }, { price: 1.86, size: 2688.94 }],
          availableToLay: [{ price: 1.88, size: 1909.62 }, { price: 1.89, size: 381.67 }],
        },
      },
    ],
    '273': [
      { marketId: 273, outcomeId: 273, price: 2.14 },
      { marketId: 273, outcomeId: 274, outcomeName: 'X', price: 2.0 },
      { marketId: 273, outcomeId: 275, price: 1.80 },
    ],
    '276': [
      { marketId: 276, outcomeId: 276, price: 50 },
      { marketId: 276, outcomeId: 277, price: 1.01 },
    ],
  };

  const t20Picked = selectAccurateMatchOddsMarket(byMarket, false);
  assert.equal(t20Picked.length, 2);
  assert.equal(t20Picked[0].marketId, 271);
  assert.equal(t20Picked[0].price, 2.12);

  const depth = extractRunnerDepthFromQuote(t20Picked[0], true);
  assert.equal(depth.back, 2.12);
  assert.equal(depth.backVol, '2.1K');
  assert.equal(depth.lay, 2.16);
  assert.equal(depth.backOdds.length, 3);
  assert.equal(depth.layOdds.length, 3);

  // Test match prioritizes 273 (incl. Draw)
  const testPicked = selectAccurateMatchOddsMarket(byMarket, true);
  assert.equal(testPicked.length, 3);
  assert.equal(testPicked[0].marketId, 273);
});

test('selectAccurateMatchOddsMarket never picks side markets (276/278/2710) or over line markets', () => {
  const onlySideMarkets = {
    '276': [{ marketId: 276, outcomeId: 276, price: 50 }, { marketId: 276, outcomeId: 277, price: 1.01 }],
    '278': [{ marketId: 278, outcomeId: 278, price: 1.97 }, { marketId: 278, outcomeId: 279, price: 1.97 }],
    '273956': [{ marketId: 273956, outcomeId: 273956, price: 1.9, handicap: 50.5 }],
  };
  assert.equal(selectAccurateMatchOddsMarket(onlySideMarkets, false), null);
});

test('resolveBetfairFancyMeta maps verified Oddspapi overs & innings runs marketIds', () => {
  assert.equal(resolveBetfairFancyMeta({ marketId: 273956 })?.name, '2nd Innings 6 Overs Line');
  assert.equal(resolveBetfairFancyMeta({ marketId: 273524 })?.name, '1st Innings 6 Overs Line');
  assert.equal(resolveBetfairFancyMeta({ marketId: 27160 })?.name, '1st Innings Runs Line');
  assert.equal(resolveBetfairFancyMeta({ marketId: 27762 })?.name, '2nd Innings Runs Line');
  assert.equal(resolveBetfairFancyMeta({ marketId: 271 }), null);
  assert.equal(resolveBetfairFancyMeta({ marketId: 276 }), null);
  assert.equal(resolveBetfairFancyMeta({ marketId: 2724029 }), null);
});

test('extractBetfairFancyMarkets extracts real Oddspapi Betfair Fancy ladders and avoids fake synthesis', () => {
  assert.deepEqual(fancyMarketsService.extractBetfairFancyMarkets(null, {}), []);
  assert.deepEqual(
    fancyMarketsService.extractBetfairFancyMarkets({ 'betfair-ex': { q1: { marketId: 271, outcomeId: 271, price: 1.5 } } }, {}),
    []
  );

  // Case A: Multiple Oddspapi Over/Under totals quotes across lines for 2nd Innings 6 Overs Line (273956..274386)
  const normalizedOdds = {
    'betfair-ex': {
      q48o: { marketId: 273956, outcomeId: 273956, handicap: 48.5, price: 1.50, active: true, limit: 2900000 },
      q48u: { marketId: 273956, outcomeId: 273957, handicap: 48.5, price: 2.50, active: true, limit: 2900000 },
      q49o: { marketId: 273958, outcomeId: 273958, handicap: 49.5, price: 1.72, active: true, limit: 3500000 },
      q49u: { marketId: 273958, outcomeId: 273959, handicap: 49.5, price: 2.15, active: true, limit: 3500000 },
      q50o: { marketId: 273960, outcomeId: 273960, handicap: 50.5, price: 1.94, active: true, limit: 16800000 },
      q50u: { marketId: 273960, outcomeId: 273961, handicap: 50.5, price: 1.96, active: true, limit: 775300 },
      q51o: { marketId: 273962, outcomeId: 273962, handicap: 51.5, price: 2.18, active: true, limit: 2700000 },
      q51u: { marketId: 273962, outcomeId: 273963, handicap: 51.5, price: 1.70, active: true, limit: 2700000 },
      q52o: { marketId: 273964, outcomeId: 273964, handicap: 52.5, price: 2.55, active: true, limit: 2600000 },
      q52u: { marketId: 273964, outcomeId: 273965, handicap: 52.5, price: 1.48, active: true, limit: 2600000 },
    },
  };

  const bfMarkets = fancyMarketsService.extractBetfairFancyMarkets(normalizedOdds, { teamA: 'MI Emirates', teamB: 'Desert Vipers' });
  assert.equal(bfMarkets.length, 1);
  assert.equal(bfMarkets[0].name, '2nd Innings 6 Overs Line');
  assert.equal(bfMarkets[0].status, 'OPEN');
  assert.deepEqual(bfMarkets[0].backOdds.map(x => x.price), [51, 52, 53]);
  assert.deepEqual(bfMarkets[0].layOdds.map(x => x.price), [50, 49, 48]);
  assert.equal(bfMarkets[0].backOdds[0].volume, '16.8M');
  assert.equal(bfMarkets[0].layOdds[0].volume, '775.3K');

  // Limit category maps betfair_fancy cleanly
  assert.equal(normalizeCategory('betfair_fancy'), 'fancy');
});

test('oddsApiRest.getFixtureOdds always includes default bookmakers filter for live Oddspapi v5 fixtures', async () => {
  const oddsApiRest = require('../services/oddsApiRest');
  const originalRequest = oddsApiRest.request.bind(oddsApiRest);
  let captured = null;
  oddsApiRest.request = async (endpoint, params) => {
    captured = { endpoint, params };
    return { fixtureId: params.fixtureId, odds: {} };
  };
  try {
    await oddsApiRest.getFixtureOdds('id2703874977212836');
    assert.equal(captured.endpoint, 'fixtures/odds');
    assert.equal(captured.params.fixtureId, 'id2703874977212836');
    assert.equal(captured.params.bookmakers, 'betfair-ex,pinnacle');
  } finally {
    oddsApiRest.request = originalRequest;
  }
});

test('OddsApiLiveService propagates live event odds to ALL linked sibling matches with independent team swap', async () => {
  const oddsApiLive = require('../services/oddsApiLiveService');
  const Match = require('../models/Match');
  const eventId = 'id_test_reissued_999';
  const primaryId = 'id_test_reissued_999';
  const siblingId = 'id_test_sibling_888';

  const origFindOne = Match.findOne;
  const origEmit = oddsApiLive.io;
  const emittedPayloads = [];

  Match.findOne = async ({ matchId }) => {
    if (matchId === primaryId) return { matchId: primaryId, teamA: 'MI Emirates', teamB: 'Desert Vipers', isTestMatch: false };
    if (matchId === siblingId) return { matchId: siblingId, teamA: 'Desert Vipers', teamB: 'MI Emirates', isTestMatch: false };
    return null;
  };
  oddsApiLive.io = {
    emit: (ev, payload) => {
      if (ev === 'market_odds_update') emittedPayloads.push(payload);
    },
    to: () => ({ emit: () => {} }),
  };

  try {
    oddsApiLive.eventMetadata.set(eventId, {
      eventId,
      home: 'MI Emirates',
      away: 'Desert Vipers',
      league: 'ILT20',
      isLive: true,
    });
    oddsApiLive.addEventMatchLink(eventId, siblingId);
    oddsApiLive.addEventMatchLink(eventId, primaryId, { primary: true });

    await oddsApiLive.processOddsForEvent({
      fixtureId: eventId,
      odds: {
        'betfair-ex': {
          qHome: {
            marketId: 271,
            outcomeId: 271,
            price: 1.60,
            active: true,
            meta: {
              availableToBack: [{ price: 1.60, size: 4800000 }],
              availableToLay: [{ price: 1.61, size: 4000000 }],
            },
          },
          qAway: {
            marketId: 271,
            outcomeId: 272,
            price: 2.64,
            active: true,
            meta: {
              availableToBack: [{ price: 2.64, size: 173200 }],
              availableToLay: [{ price: 2.66, size: 213900 }],
            },
          },
        },
      },
    });

    const primaryWrite = oddsApiLive.writeQueue.get(primaryId);
    const siblingWrite = oddsApiLive.writeQueue.get(siblingId);
    assert.ok(primaryWrite, 'primary reissued match must be queued');
    assert.ok(siblingWrite, 'swapped sibling match must ALSO be queued');

    assert.equal(primaryWrite.teamABack, 1.60);
    assert.equal(primaryWrite.teamALay, 1.61);
    assert.equal(primaryWrite.teamBBack, 2.64);
    assert.equal(primaryWrite.teamBLay, 2.66);

    assert.equal(siblingWrite.teamABack, 2.64);
    assert.equal(siblingWrite.teamALay, 2.66);
    assert.equal(siblingWrite.teamBBack, 1.60);
    assert.equal(siblingWrite.teamBLay, 1.61);

    assert.equal(emittedPayloads.length, 2);
  } finally {
    Match.findOne = origFindOne;
    oddsApiLive.io = origEmit;
    oddsApiLive.eventMetadata.delete(eventId);
    oddsApiLive.eventQuotes.delete(eventId);
    oddsApiLive.eventToMatchIds.delete(eventId);
    oddsApiLive.eventToMatchId.delete(eventId);
    oddsApiLive.swapCache.delete(primaryId);
    oddsApiLive.swapCache.delete(siblingId);
    oddsApiLive.oddsCache.delete(primaryId);
    oddsApiLive.oddsCache.delete(siblingId);
    oddsApiLive.writeQueue.delete(primaryId);
    oddsApiLive.writeQueue.delete(siblingId);
  }
});
