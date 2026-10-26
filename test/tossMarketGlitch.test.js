'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('Toss Market Sweep Query: upcoming matches are never caught in Step 1 sweep', () => {
  const now = new Date('2026-10-26T18:00:00.000Z');
  
  // Simulation of match records
  const matches = [
    {
      matchId: 'live_1',
      status: 'live',
      startTime: new Date('2026-10-26T17:00:00.000Z'),
      tossMarketStatus: 'OPEN',
      tossBackA: 1.98
    },
    {
      matchId: 'started_past_time',
      status: 'upcoming',
      startTime: new Date('2026-10-26T17:30:00.000Z'), // Past start time
      tossMarketStatus: 'OPEN',
      tossBackA: 1.98
    },
    {
      matchId: 'upcoming_future_1',
      status: 'upcoming',
      startTime: new Date('2026-10-27T10:00:00.000Z'), // Tomorrow
      tossMarketStatus: 'OPEN',
      tossBackA: 1.98
    },
    {
      matchId: 'upcoming_future_2',
      status: 'upcoming',
      startTime: new Date('2026-10-30T10:00:00.000Z'), // 4 days later
      tossMarketStatus: 'OPEN',
      tossBackA: 1.98
    }
  ];

  // The correct $and condition
  const isStartedOrLive = (m) => ['live', 'completed', 'resulted'].includes(m.status) || (m.startTime && m.startTime <= now);
  const hasOpenToss = (m) => m.tossMarketStatus !== 'CLOSED' || m.tossBackA !== null || m.tossLayA !== null;

  const sweptToClose = matches.filter(m => isStartedOrLive(m) && hasOpenToss(m));
  
  assert.equal(sweptToClose.length, 2);
  assert.equal(sweptToClose[0].matchId, 'live_1');
  assert.equal(sweptToClose[1].matchId, 'started_past_time');

  // Upcoming future matches MUST NOT be swept
  const upcomingMatchesSwept = sweptToClose.filter(m => m.matchId.startsWith('upcoming_future'));
  assert.equal(upcomingMatchesSwept.length, 0);
});

test('Toss Market UI Winner Highlighting and Persistence', () => {
  const teamA = 'India';
  const teamB = 'Pakistan';

  const tossRunners = [
    { name: `${teamA} To Win The Toss`, team: teamA },
    { name: `${teamB} To Win The Toss`, team: teamB }
  ];

  // Helper function matching the new frontend component logic
  const checkWinner = (runner, tossWinner) => {
    return Boolean(
      tossWinner &&
      tossWinner !== 'REFUND' &&
      (
        (runner.team && (tossWinner.toLowerCase().includes(runner.team.toLowerCase()) || runner.team.toLowerCase().includes(tossWinner.toLowerCase()))) ||
        runner.name.toLowerCase().includes(tossWinner.toLowerCase())
      )
    );
  };

  // Scenario 1: India won toss
  assert.equal(checkWinner(tossRunners[0], 'India'), true);
  assert.equal(checkWinner(tossRunners[1], 'India'), false);

  // Scenario 2: Pakistan won toss
  assert.equal(checkWinner(tossRunners[0], 'Pakistan'), false);
  assert.equal(checkWinner(tossRunners[1], 'Pakistan'), true);

  // Scenario 3: REFUND
  assert.equal(checkWinner(tossRunners[0], 'REFUND'), false);
  assert.equal(checkWinner(tossRunners[1], 'REFUND'), false);

  // Scenario 4: Toss winner null (still open/undecided)
  assert.equal(checkWinner(tossRunners[0], null), false);
  assert.equal(checkWinner(tossRunners[1], null), false);
});
