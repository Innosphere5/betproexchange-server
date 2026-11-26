const test = require('node:test');
const assert = require('node:assert/strict');
const Match = require('../models/Match');
const { shouldIncludeFixture, getMatchScheduleWindow, isTestMatchFormat } = require('../services/fixtureFilter');
const { extractMatchOdds } = require('../services/matchService');
const { SupabaseService } = require('../services/supabaseService');

test('Schedule window includes yesterday, today, and tomorrow upcoming matches (excludes 2+ days future unless live)', () => {
  // Reference time: 2026-11-26 16:00:00Z (= 21:00:00 PKT UTC+5 on 2026-11-26)
  const refNow = new Date('2026-11-26T16:00:00.000Z');
  const { windowStartMs, windowEndMs } = getMatchScheduleWindow(refNow, 300);

  // Yesterday local PKT (2026-11-25 14:00 PKT = 09:00Z) -> included
  const yesterdayMatch = {
    sport: { sportName: 'Cricket' },
    tournament: { tournamentName: 'ODI Series' },
    participants: { participant1Name: 'India', participant2Name: 'New Zealand' },
    startTime: Math.floor(new Date('2026-11-25T09:00:00.000Z').getTime() / 1000),
    status: { live: false, statusName: 'Pre-Game' },
  };
  assert.equal(shouldIncludeFixture(yesterdayMatch, refNow), true);

  // Today / tonight / tomorrow upcoming (<2 days after today, e.g. 2026-11-27 14:30Z) -> included
  const tomorrowMatch = {
    ...yesterdayMatch,
    startTime: Math.floor(new Date('2026-11-27T14:30:00.000Z').getTime() / 1000),
  };
  assert.equal(shouldIncludeFixture(tomorrowMatch, refNow), true);

  // 2 days after (2026-11-28) -> excluded
  const twoDaysLater = {
    ...yesterdayMatch,
    startTime: Math.floor(new Date('2026-11-28T09:00:00.000Z').getTime() / 1000),
  };
  assert.equal(shouldIncludeFixture(twoDaysLater, refNow), false);

  // 3 days after (2026-11-29) -> excluded
  const threeDaysLater = {
    ...yesterdayMatch,
    startTime: Math.floor(new Date('2026-11-29T09:00:00.000Z').getTime() / 1000),
  };
  assert.equal(shouldIncludeFixture(threeDaysLater, refNow), false);

  // Completed / resulted match -> excluded from active feed even if started today
  const completedToday = {
    ...tomorrowMatch,
    status: 'completed',
    winner: 'India',
  };
  assert.equal(shouldIncludeFixture(completedToday, refNow), false);

  // Multi-day LIVE Test match that started 3 days ago -> still included while live
  const multiDayLiveTest = {
    ...yesterdayMatch,
    tournament: { tournamentName: 'Test Series' },
    startTime: Math.floor(new Date('2026-11-23T04:00:00.000Z').getTime() / 1000),
    status: { live: true, statusName: 'InPlay' },
  };
  assert.equal(shouldIncludeFixture(multiDayLiveTest, refNow), true);

  // Exact bounds check (< 72h total span: yesterday 00:00 to tomorrow 23:59)
  assert.equal(windowEndMs - windowStartMs, 72 * 60 * 60 * 1000 - 1);
});

test('The Draw is strictly restricted to Test/First-Class matches (never T10, T20, ODI)', () => {
  const sample3WayOdds = {
    odds: {
      'betfair-ex': {
        q1: { marketId: 273, outcomeId: 273, outcomeName: '1', price: 3.05, meta: { availableToBack: [{ price: 3.05, size: 17000 }], availableToLay: [{ price: 3.15, size: 22000 }] } },
        qx: { marketId: 273, outcomeId: 274, outcomeName: 'X', price: 70, meta: { availableToBack: [{ price: 70, size: 15 }], availableToLay: [{ price: 90, size: 44 }] } },
        q2: { marketId: 273, outcomeId: 275, outcomeName: '2', price: 1.49, meta: { availableToBack: [{ price: 1.49, size: 26000 }], availableToLay: [{ price: 1.51, size: 32000 }] } },
      }
    }
  };

  const t20Match = { league: 'International League T20', teamA: 'Abu Dhabi Knight Riders', teamB: 'Mi Emirates', isTestMatch: true };
  assert.equal(isTestMatchFormat(t20Match), false);
  const t20Odds = extractMatchOdds(sample3WayOdds, t20Match);
  assert.equal(t20Odds.isTestMatch, false);
  assert.equal(t20Odds.backOddsDraw, null);
  assert.equal(t20Odds.layOddsDraw, null);

  const t10Match = { league: 'Italia T10', teamA: 'Roma Gladiators', teamB: 'Napoli Knights' };
  assert.equal(isTestMatchFormat(t10Match), false);
  const t10Odds = extractMatchOdds(sample3WayOdds, t10Match);
  assert.equal(t10Odds.backOddsDraw, null);

  const odiMatch = { league: 'ODI Series Australia vs England', teamA: 'Australia', teamB: 'England' };
  assert.equal(isTestMatchFormat(odiMatch), false);
  const odiOdds = extractMatchOdds(sample3WayOdds, odiMatch);
  assert.equal(odiOdds.backOddsDraw, null);

  const testMatch = { league: 'Test Series New Zealand vs India', teamA: 'New Zealand', teamB: 'India' };
  assert.equal(isTestMatchFormat(testMatch), true);
  const testOdds = extractMatchOdds(sample3WayOdds, testMatch);
  assert.equal(testOdds.isTestMatch, true);
  assert.equal(testOdds.backOddsDraw, 70);
  assert.equal(testOdds.layOddsDraw, 90);
});

test('Match schema includes completedAt field and 24-hour (86400s) TTL index', () => {
  assert.ok(Match.schema.path('completedAt'), 'completedAt field must exist on Match schema');
  const indexes = Match.schema.indexes();
  const ttlIndex = indexes.find(([fields, opts]) => fields.completedAt === 1 && opts?.expireAfterSeconds === 86400);
  assert.ok(ttlIndex, 'Expected 86400s TTL index on Match.completedAt');
});

test('SupabaseService row builders set 24h expires_at and preserve ledger/bet fields', () => {
  const completedAt = new Date('2026-11-26T10:00:00.000Z');
  const resultRow = SupabaseService.buildMatchResultRow({
    matchId: 'id2704941876121502',
    teamA: 'Pakistan',
    teamB: 'Bangladesh',
    league: 'T20 Emerging Nations Trophy',
    winner: 'Pakistan',
    completedAt,
    score: { teamA_runs: '112/0', teamB_runs: '108/0' },
  }, completedAt);

  assert.equal(resultRow.match_id, 'id2704941876121502');
  assert.equal(resultRow.winner, 'Pakistan');
  assert.equal(resultRow.completed_at, '2026-11-26T10:00:00.000Z');
  assert.equal(resultRow.expires_at, '2026-11-27T10:00:00.000Z');

  const betRow = SupabaseService.buildSettledBetRow({
    _id: 'bet_abc',
    userId: 'neha',
    matchId: 'id123',
    matchName: 'Pakistan v India',
    runner: 'Pakistan',
    type: 'back',
    marketType: 'match_odds',
    stake: 1000,
    odds: 1.95,
    payout: 1902,
    status: 'won',
    result: 'Pakistan',
    settledAt: completedAt,
  });
  assert.equal(betRow.bet_id, 'bet_abc');
  assert.equal(betRow.payout, 1902);

  const ledgerRow = SupabaseService.buildLedgerRow({
    _id: 'tx_xyz',
    userId: 'adnan',
    amount: 500,
    type: 'COMMISSION_SHARE',
    bettor: 'neha',
    downline: 'master1',
    createdAt: completedAt,
  });
  assert.equal(ledgerRow.mongo_tx_id, 'tx_xyz');
  assert.equal(ledgerRow.tx_type, 'COMMISSION_SHARE');
});
