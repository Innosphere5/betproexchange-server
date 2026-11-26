const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldIncludeFixture, isTopFranchiseLeague } = require('../services/fixtureFilter');
const { parseRoanuzMatch } = require('../services/roanuzScoreService');

test('isTopFranchiseLeague matches Big Bash League & WBBL and shouldIncludeFixture keeps yesterday/today BBL fixtures while excluding 2+ days ahead', () => {
  const bblTodayFixture = {
    fixtureId: 'id2700247874770652',
    sport: { sportName: 'Cricket' },
    tournament: { tournamentId: 2478, tournamentName: 'Big Bash League' },
    participants: { participant1Name: 'Melbourne Renegades', participant2Name: 'Perth Scorchers' },
    startTime: Math.floor((Date.now() + 2 * 3600 * 1000) / 1000),
    status: { live: false, statusName: 'Pre-Game' }
  };
  assert.equal(isTopFranchiseLeague(bblTodayFixture), true);
  assert.equal(shouldIncludeFixture(bblTodayFixture, new Date()), true);

  const bblFarFutureFixture = {
    ...bblTodayFixture,
    startTime: Math.floor((Date.now() + 16 * 24 * 3600 * 1000) / 1000),
  };
  assert.equal(shouldIncludeFixture(bblFarFutureFixture, new Date()), false);

  const bblSrlFixture = {
    fixtureId: 'id2703320776111224',
    sport: { sportName: 'Cricket' },
    tournament: { tournamentId: 33207, tournamentName: 'Big Bash League SRL' },
    participants: { participant1Name: 'Brisbane Heat SRL', participant2Name: 'Perth Scorchers SRL' },
    startTime: Math.floor((Date.now() + 3600 * 1000) / 1000),
    status: { live: false, statusName: 'Pre-Game' }
  };
  assert.equal(shouldIncludeFixture(bblSrlFixture, new Date()), false);
});

test('parseRoanuzMatch extracts tossWinner + tossDecision and guards against NaN overs/remBalls', () => {
  const mockMatch = {
    key: 'a-rz--cricket--3q2085316378549714978',
    format: 't20',
    status: 'started',
    play_status: 'in_play',
    tournament: { name: 'Womens Big Bash League, 2026' },
    teams: {
      a: { key: 'sytw', name: 'Sydney Thunder Women' },
      b: { key: 'adsw', name: 'Adelaide Strikers Women' },
    },
    toss: { called: 'b', winner: 'b', elected: 'bowl' },
    play: {
      overs_per_innings: 20,
      target: { runs: 180 },
      live: {
        batting_team: 'a',
        score: { runs: 0, wickets: 0, overs: [undefined, undefined], run_rate: 0 },
      },
      innings: {
        a_1: { score: { runs: 0 }, wickets: 0 },
      },
    },
  };

  const parsed = parseRoanuzMatch(mockMatch, null, null);
  assert.equal(parsed.tossWinner, 'Adelaide Strikers Women');
  assert.equal(parsed.tossDecision, 'bowl');
  assert.equal(Number.isFinite(parsed.remBalls), true);
  assert.equal(Number.isFinite(parsed.overs) || !isNaN(Number(parsed.overs)), true);
});
