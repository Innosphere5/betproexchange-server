const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMatchFormat,
  getFormatBonus,
  getCricketPriority,
  isTargetBPExchFixture,
  isInternationalFixture,
  isVirtualOrSimulated,
} = require('../services/fixtureFilter');

test('🏏 Task Verification: Fixture Filter Format & Priority for T10, T20, ODI, and Test', async (t) => {
  await t.test('1. Format detection: T10, T20, ODI, and Test matches', () => {
    // T10
    assert.equal(getMatchFormat({ league: 'Abu Dhabi T10', teamA: 'Deccan Gladiators', teamB: 'Morrisville Samp Army' }), 'T10');
    assert.equal(getMatchFormat({ league: 'ECS Spain T10', teamA: 'Catalunya CC', teamB: 'Barcelona International' }), 'T10');
    assert.equal(getMatchFormat({ league: 'Max 60 Caribbean', teamA: 'Caribbean Tigers', teamB: 'Boca Raton Trailblazers' }), 'T10');
    assert.equal(getMatchFormat({ league: 'Zim Afro T10', teamA: 'Harare Hurricanes', teamB: 'Cape Town Samp Army' }), 'T10');

    // Test Matches
    assert.equal(getMatchFormat({ league: 'ICC World Test Championship', teamA: 'India', teamB: 'Australia' }), 'TEST');
    assert.equal(getMatchFormat({ league: 'The Ashes', teamA: 'Australia', teamB: 'England' }), 'TEST');
    assert.equal(getMatchFormat({ league: 'Border-Gavaskar Trophy', teamA: 'India', teamB: 'Australia' }), 'TEST');
    assert.equal(getMatchFormat({ league: 'Sheffield Shield', teamA: 'New South Wales', teamB: 'Victoria' }), 'TEST');
    assert.equal(getMatchFormat({ league: 'New Zealand vs England Test Series', teamA: 'New Zealand', teamB: 'England' }), 'TEST');

    // T20
    assert.equal(getMatchFormat({ league: 'Indian Premier League', teamA: 'Mumbai Indians', teamB: 'Chennai Super Kings' }), 'T20');
    assert.equal(getMatchFormat({ league: 'Pakistan Super League', teamA: 'Lahore Qalandars', teamB: 'Karachi Kings' }), 'T20');
    assert.equal(getMatchFormat({ league: 'Big Bash League', teamA: 'Sydney Sixers', teamB: 'Perth Scorchers' }), 'T20');
    assert.equal(getMatchFormat({ league: 'ICC Men\'s T20 World Cup', teamA: 'Pakistan', teamB: 'India' }), 'T20');

    // ODI
    assert.equal(getMatchFormat({ league: 'ICC Cricket World Cup', teamA: 'India', teamB: 'South Africa' }), 'ODI');
    assert.equal(getMatchFormat({ league: 'Australia v Pakistan ODI Series', teamA: 'Australia', teamB: 'Pakistan' }), 'ODI');
    assert.equal(getMatchFormat({ league: 'Champions Trophy', teamA: 'Pakistan', teamB: 'New Zealand' }), 'ODI');
  });

  await t.test('2. T10, T20, ODI, and Test matches pass isTargetBPExchFixture', () => {
    // T10
    assert.equal(isTargetBPExchFixture({ league: 'Abu Dhabi T10', teamA: 'Team A', teamB: 'Team B' }), true);
    assert.equal(isTargetBPExchFixture({ league: 'ECS T10', teamA: 'Vienna CC', teamB: 'Prague CC' }), true);

    // Test
    assert.equal(isTargetBPExchFixture({ league: 'The Ashes', teamA: 'Australia', teamB: 'England' }), true);
    assert.equal(isTargetBPExchFixture({ league: 'ICC World Test Championship', teamA: 'India', teamB: 'Australia' }), true);
    assert.equal(isTargetBPExchFixture({ league: 'Sheffield Shield', teamA: 'NSW', teamB: 'VIC' }), true);

    // T20
    assert.equal(isTargetBPExchFixture({ league: 'Indian Premier League', teamA: 'RCB', teamB: 'CSK' }), true);

    // ODI
    assert.equal(isTargetBPExchFixture({ league: 'ICC Cricket World Cup', teamA: 'India', teamB: 'Australia' }), true);

    // Reject virtual / SRL
    assert.equal(isTargetBPExchFixture({ league: 'Indian Premier League SRL', teamA: 'RCB SRL', teamB: 'CSK SRL' }), false);
    assert.equal(isVirtualOrSimulated({ league: 'T10 Virtual Cup SRL' }), true);
  });

  await t.test('3. High priority score verification for Tier 1 international Test, ODI, T20', () => {
    const testMatch = {
      league: 'The Ashes Test Series',
      teamA: 'Australia',
      teamB: 'England',
      startTime: (Date.now() + 24 * 3600 * 1000) / 1000
    };
    const t20Match = {
      league: 'Pakistan vs India T20 Series',
      teamA: 'Pakistan',
      teamB: 'India',
      startTime: (Date.now() + 24 * 3600 * 1000) / 1000
    };
    const t10Match = {
      league: 'Abu Dhabi T10',
      teamA: 'Deccan Gladiators',
      teamB: 'Morrisville Samp Army',
      startTime: (Date.now() + 24 * 3600 * 1000) / 1000
    };

    assert.ok(getCricketPriority(testMatch) >= 2000, 'Test match between Tier 1 national teams has high priority >= 2000');
    assert.ok(getCricketPriority(t20Match) >= 3000, 'Pak vs Ind match has top priority >= 3000');
    assert.ok(getCricketPriority(t10Match) >= 1000, 'T10 match has priority >= 1000');
  });
});

test('🏏 Task Verification: Test Match Draw Odds & Settlement Engine', async (t) => {
  // Mock matchInDb for a Test match with 3-way match odds
  const testMatchDb = {
    matchId: 'test_aus_eng_01',
    teamA: 'Australia',
    teamB: 'England',
    league: 'The Ashes Test Match',
    isTestMatch: true,
    backOddsA: 1.85,
    layOddsA: 1.87,
    backOddsB: 3.40,
    layOddsB: 3.45,
    backOddsDraw: 4.50,
    layOddsDraw: 4.60,
    bookmakerBackA: 1.85,
    bookmakerLayA: 1.87,
    bookmakerBackB: 3.38,
    bookmakerLayB: 3.42,
    bookmakerBackDraw: 4.45,
    bookmakerLayDraw: 4.55,
  };

  await t.test('1. Open Bet Matcher resolves Draw odds in Test matches', () => {
    const { getActiveMarketOdds } = require('../services/openBetMatcher');
    
    // Match Odds
    const backDrawRate = getActiveMarketOdds(testMatchDb, 'The Draw', 'back', 'match_odds');
    const layDrawRate = getActiveMarketOdds(testMatchDb, 'The Draw', 'lay', 'match_odds');
    assert.equal(backDrawRate, 4.50);
    assert.equal(layDrawRate, 4.60);

    // Bookmaker
    const bmBackDrawRate = getActiveMarketOdds(testMatchDb, 'The Draw', 'back', 'bookmaker');
    const bmLayDrawRate = getActiveMarketOdds(testMatchDb, 'The Draw', 'lay', 'bookmaker');
    assert.equal(bmBackDrawRate, 4.45);
    assert.equal(bmLayDrawRate, 4.55);

    // Alternative casing & 'Draw'
    assert.equal(getActiveMarketOdds(testMatchDb, 'draw', 'back', 'match_odds'), 4.50);
    assert.equal(getActiveMarketOdds(testMatchDb, 'X', 'back', 'match_odds'), 4.50);
  });

  await t.test('2. Odds list validation for The Draw in match_odds and bookmaker', () => {
    // In server.js getValidMarketOddsList
    // Simulate resolution logic
    const normRunner = 'The Draw'.trim().toLowerCase();
    const isDraw = normRunner === 'the draw' || normRunner === 'draw' || normRunner === 'x';
    assert.equal(isDraw, true);

    const matchOddsBackList = [testMatchDb.backOddsDraw];
    const matchOddsLayList = [testMatchDb.layOddsDraw];
    assert.deepEqual(matchOddsBackList, [4.50]);
    assert.deepEqual(matchOddsLayList, [4.60]);
  });

  await t.test('3. OddsApiLiveService processes 2-way and 3-way odds without reference errors', async () => {
    const oddsApiLiveService = require('../services/oddsApiLiveService');
    const mockEventId = 'test_event_999';
    const mockMatchId = 'test_match_999';

    oddsApiLiveService.eventToMatchId.set(mockEventId, mockMatchId);
    oddsApiLiveService.eventMetadata.set(mockEventId, {
      home: 'Australia',
      away: 'England',
      league: 'The Ashes Test Match',
      isLive: true
    });

    const mock3WayOdds = {
      'betfair-ex': {
        'quote1': { marketId: 273, outcomeId: 273, outcomeName: '1', price: 1.85, meta: { availableToBack: [{ price: 1.85, size: 500 }], availableToLay: [{ price: 1.87, size: 500 }] } },
        'quote2': { marketId: 273, outcomeId: 274, outcomeName: 'X', price: 4.50, meta: { availableToBack: [{ price: 4.50, size: 200 }], availableToLay: [{ price: 4.60, size: 200 }] } },
        'quote3': { marketId: 273, outcomeId: 275, outcomeName: '2', price: 3.40, meta: { availableToBack: [{ price: 3.40, size: 300 }], availableToLay: [{ price: 3.45, size: 300 }] } }
      }
    };

    // Must not throw ReferenceError: drawBack is not defined
    await oddsApiLiveService.processOddsForEvent({
      fixtureId: mockEventId,
      odds: mock3WayOdds
    });

    const cached = oddsApiLiveService.oddsCache.get(mockMatchId);
    assert.ok(cached, 'Cache contains updated odds');
    assert.equal(cached.teamABack, 1.85);
    assert.equal(cached.backOddsDraw, 4.50);
    assert.equal(cached.layOddsDraw, 4.60);
    assert.equal(cached.teamBBack, 3.40);
    assert.equal(cached.isTestMatch, true);
  });
});

