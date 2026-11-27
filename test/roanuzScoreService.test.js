const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoanuzMatch, formatRoanuzBallBadge, formatReprBadge } = require('../services/roanuzScoreService');
const roanuzClient = require('../services/roanuzClient');

test('🏏 Roanuz API Client: Authentication and Token Caching', async () => {
  assert.equal(roanuzClient.projectKey, 'RS_P_2116179427653193740');
  assert.equal(roanuzClient.apiKey, 'RS5:ce5d8bd1983f35ecf5f87a416378e75f');

  // Verify token acquisition and caching
  const token = await roanuzClient.getAuthToken();
  assert.ok(token && typeof token === 'string', 'Token must be a valid string');
  assert.ok(token.startsWith('v5s'), 'Roanuz v5 token format starts with v5s');

  const cachedToken = await roanuzClient.getAuthToken();
  assert.equal(cachedToken, token, 'Subsequent call must return cached token without duplicate auth hit');
});

test('🏏 Roanuz Ball Badge Formatter: Correct cricket notation for all delivery types', () => {
  // Dot ball
  assert.equal(formatRoanuzBallBadge({ repr: 'r0', team_score: { runs: 0 } }), '0');
  // Normal runs
  assert.equal(formatRoanuzBallBadge({ repr: 'r1', team_score: { runs: 1 } }), '1');
  assert.equal(formatRoanuzBallBadge({ repr: 'r2', team_score: { runs: 2 } }), '2');
  assert.equal(formatRoanuzBallBadge({ repr: 'r3', team_score: { runs: 3 } }), '3');
  assert.equal(formatRoanuzBallBadge({ repr: 'r4', team_score: { runs: 4 } }), '4');
  assert.equal(formatRoanuzBallBadge({ repr: 'r6', team_score: { runs: 6 } }), '6');
  // Wicket
  assert.equal(formatRoanuzBallBadge({ repr: 'w', is_wicket: true }), 'W');
  assert.equal(formatRoanuzBallBadge({ repr: 'w1', is_wicket: true, team_score: { runs: 1 } }), 'W');
  assert.equal(formatRoanuzBallBadge({ wicket: { kind: 'bowled' } }), 'W');
  // Extras
  assert.equal(formatRoanuzBallBadge({ repr: 'wd', team_score: { runs: 1 } }), 'Wd');
  assert.equal(formatRoanuzBallBadge({ repr: 'wd2', team_score: { runs: 2 } }), '2Wd');
  assert.equal(formatRoanuzBallBadge({ repr: 'nb', team_score: { runs: 1 } }), 'Nb');
  assert.equal(formatRoanuzBallBadge({ repr: 'nb4', team_score: { runs: 5 } }), '5Nb');
  assert.equal(formatRoanuzBallBadge({ repr: 'b1', team_score: { runs: 1 } }), 'B');
  assert.equal(formatRoanuzBallBadge({ repr: 'lb1', team_score: { runs: 1 } }), 'Lb');
});

test('🏏 Roanuz Match Parser: Comprehensive scorecard, batsmen, bowler and over parsing', () => {
  const mockMatchData = {
    key: 'mock-rz-match-001',
    name: 'Australia vs England',
    format: 'oneday',
    status: 'started',
    play_status: 'in_play',
    teams: {
      a: { key: 'aus', code: 'AUS', name: 'Australia' },
      b: { key: 'eng', code: 'ENG', name: 'England' }
    },
    toss: {
      winner: 'b',
      elected: 'bat'
    },
    play: {
      overs_per_innings: 50,
      target: { runs: 0 },
      innings: {
        b_1: {
          is_completed: false,
          overs: [28, 0],
          score: { runs: 170, balls: 168 },
          wickets: 3
        },
        a_1: {
          is_completed: false,
          overs: [0, 0],
          score: { runs: 0, balls: 0 },
          wickets: 0
        }
      },
      live: {
        innings: 'b_1',
        batting_team: 'b',
        bowling_team: 'a',
        score: {
          runs: 170,
          wickets: 3,
          overs: [28, 0],
          run_rate: 6.07
        },
        recent_players: {
          striker: {
            key: 'p_duckett',
            name: 'Ben Duckett',
            stats: { runs: 80, balls: 75, fours: 12, sixes: 0, strike_rate: 106.67 }
          },
          non_striker: {
            key: 'p_cox',
            name: 'Jordan Cox',
            stats: { runs: 11, balls: 22, fours: 0, sixes: 0, strike_rate: 50.0 }
          },
          bowler: {
            key: 'p_renshaw',
            name: 'Matt Renshaw',
            stats: { overs: [6, 0], maiden_overs: 0, runs: 21, wickets: 1, economy: 3.5 }
          }
        },
        recent_overs_repr: [
          {
            overnumber: 27,
            ball_repr: ['r0', 'r1', 'r0', 'r4', 'r1', 'r0']
          }
        ]
      }
    }
  };

  const mockBallByBall = {
    data: {
      over: {
        index: { innings: 'b_1', over_number: 28 },
        balls: [
          { comment: 'Matt Renshaw to Jordan Cox: 1 run.', repr: 'r1', overs: [27, 1] },
          { comment: 'Matt Renshaw to Ben Duckett: No runs.', repr: 'r0', overs: [27, 2] },
          { comment: 'Matt Renshaw to Ben Duckett: FOUR runs.', repr: 'r4', overs: [27, 3] },
          { comment: 'Matt Renshaw to Ben Duckett: WICKET!', repr: 'w', is_wicket: true, overs: [27, 4] }
        ]
      }
    }
  };

  const parsed = parseRoanuzMatch(mockMatchData, mockBallByBall);

  // Assert general match info
  assert.equal(parsed.matchId, 'mock-rz-match-001');
  assert.equal(parsed.teamA, 'Australia');
  assert.equal(parsed.teamB, 'England');
  assert.equal(parsed.status, 'live');

  // Assert scores and wickets
  assert.equal(parsed.teamA_runs, '0/0');
  assert.equal(parsed.teamB_runs, '170/3');
  assert.equal(parsed.wickets, 3);
  assert.equal(parsed.overs, '28');
  assert.equal(parsed.runRate, '6.07');
  assert.equal(parsed.battingTeam, 'teamB');
  assert.equal(parsed.battingTeamName, 'England');

  // Assert Toss
  assert.equal(parsed.tossWinner, 'England');
  assert.equal(parsed.tossDecision, 'bat');

  // Assert Batsmen
  assert.equal(parsed.batsmen.length, 2);
  assert.equal(parsed.batsmen[0].name, 'Ben Duckett');
  assert.equal(parsed.batsmen[0].runs, 80);
  assert.equal(parsed.batsmen[1].name, 'Jordan Cox');
  assert.equal(parsed.batsmen[1].runs, 11);

  // Assert Bowler
  assert.ok(parsed.bowler);
  assert.equal(parsed.bowler.name, 'Matt Renshaw');
  assert.equal(parsed.bowler.wickets, 1);
  assert.equal(parsed.bowler.overs, '6.0');

  // Assert thisOver Badges and Commentary
  assert.deepEqual(parsed.thisOver, ['1', '0', '4', 'W']);
  assert.ok(parsed.lastBall.includes('Matt Renshaw to Ben Duckett: WICKET!'));
});

test('🏏 Roanuz Descending Balls Fix: Sorts reverse-chronological API deliveries ascending and picks latest ball', () => {
  const reverseOrderMatch = {
    key: 'a-rz--cricket--rZ2070749752328343616',
    format: 'test',
    status: 'started',
    teams: { a: { key: 'nz', name: 'New Zealand' }, b: { key: 'ind', name: 'India' } },
    play: {
      innings: { a_1: { score: { runs: 246 }, wickets: 5 } },
      live: {
        innings: 'a_1',
        batting_team: 'a',
        score: { runs: 246, wickets: 5, overs: [85, 0], run_rate: 2.89 },
        recent_overs_repr: [
          { overnumber: 84, ball_repr: ['r0', 'r0', 'r1', 'r0', 'r0', 'r0'] }
        ]
      }
    }
  };

  // Roanuz live API returns over.balls newest-first (6 -> 1)
  const reverseBallByBall = {
    data: {
      over: {
        index: { innings: 'a_1', over_number: 85 },
        balls: [
          { key: '567680', overs: [84, 6], repr: 'r0', comment: 'Ball 6 dot.', team_score: { runs: 0 } },
          { key: '567616', overs: [84, 5], repr: 'r0', comment: 'Ball 5 dot.', team_score: { runs: 0 } },
          { key: '567552', overs: [84, 4], repr: 'r0', comment: 'Ball 4 dot.', team_score: { runs: 0 } },
          { key: '567488', overs: [84, 3], repr: 'r1', comment: 'Ball 3 single.', team_score: { runs: 1 } },
          { key: '567424', overs: [84, 2], repr: 'r0', comment: 'Ball 2 dot.', team_score: { runs: 0 } },
          { key: '567360', overs: [84, 1], repr: 'r0', comment: 'Ball 1 dot.', team_score: { runs: 0 } },
        ]
      }
    }
  };

  const parsed = parseRoanuzMatch(reverseOrderMatch, reverseBallByBall);
  assert.deepEqual(parsed.thisOver, ['0', '0', '1', '0', '0', '0']);
  assert.ok(parsed.lastBall.startsWith('84.6:'), `Expected lastBall 84.6, got ${parsed.lastBall}`);

  // Pre-start / 0.0 overs must return [] (never dummy ['0','1','0','1'])
  const preStartMatch = {
    ...reverseOrderMatch,
    play: {
      innings: { a_1: { score: { runs: 0 }, wickets: 0 } },
      live: { innings: 'a_1', batting_team: 'a', score: { runs: 0, wickets: 0, overs: [0, 0] } }
    }
  };
  assert.deepEqual(parseRoanuzMatch(preStartMatch, null).thisOver, []);

  // Extra + wicket + compact repr formatting edge cases
  assert.equal(formatRoanuzBallBadge({ repr: 'wd', is_wicket: true, team_score: { runs: 1 } }), 'Wd+W');
  assert.equal(formatRoanuzBallBadge({ repr: 'lb4', ball_type: 'leg_bye', team_score: { runs: 4 } }), '4Lb');
  assert.equal(formatRoanuzBallBadge({ repr: 'b2', ball_type: 'bye', team_score: { runs: 2 } }), '2B');
  assert.equal(formatReprBadge('nb4'), '4Nb');
  assert.equal(formatReprBadge('lb2'), '2Lb');

  setTimeout(() => process.exit(0), 100);
});
