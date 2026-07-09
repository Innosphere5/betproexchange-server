const test = require('node:test');
const assert = require('node:assert/strict');
const { extractLiveScorePayload } = require('../services/scoreService');

test('extractLiveScorePayload parses cricket score metrics from live payload', () => {
  const payload = {
    scores: {
      result: {
        participant1Score: 64,
        participant2Score: 158,
        overs: '12.4',
        runRate: 6.33,
        reqRunRate: 5.15,
        wickets: 2,
        target: 159,
        thisOver: ['1', '4', 'W', '2'],
        remRuns: 15,
        remBalls: 6
      }
    },
    clock: {
      currentTime: '12.4'
    }
  };

  const result = extractLiveScorePayload(payload, {});

  assert.equal(result.teamA_runs, '64');
  assert.equal(result.teamB_runs, '158');
  assert.equal(result.overs, '12.4');
  assert.equal(result.runRate, '6.33');
  assert.equal(result.reqRunRate, '5.15');
  assert.equal(result.wickets, 2);
  assert.equal(result.target, 159);
  assert.deepEqual(result.thisOver, ['1', '4', 'W', '2']);
  assert.equal(result.remRuns, 15);
  assert.equal(result.remBalls, 6);
});
