const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAIR_PLUS_MULTIPLIERS,
  getHandRank,
  dealProvablyFairHands,
} = require('../services/cardGameEngine');
const roundManager = require('../services/roundManager');
const teenPattiManager = require('../services/teenPattiManager');

const c = (value, suit) => {
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  return { value, suit, rank: values.indexOf(value) };
};

function createMockIo() {
  const emitted = [];
  const makeEmitter = (room) => ({
    emit: (event, payload) => emitted.push({ room, event, payload }),
  });
  return {
    emitted,
    sockets: { adapter: { rooms: new Map() } },
    to: (room) => makeEmitter(room),
    emit: (event, payload) => emitted.push({ room: 'GLOBAL', event, payload }),
  };
}

function createMockSocket(id = 'sock-1') {
  const rooms = new Set();
  const events = [];
  return {
    id,
    rooms,
    events,
    join: (r) => rooms.add(r),
    leave: (r) => rooms.delete(r),
    emit: (event, payload) => events.push({ event, payload }),
  };
}

test('Hand ranking enforces Trail > Pure Sequence > Sequence > Color > Pair > High Card and QKA > 234 > A23', () => {
  const trail = getHandRank([c('2', '♠'), c('2', '♥'), c('2', '♦')]);
  const pureSeqQKA = getHandRank([c('Q', '♠'), c('K', '♠'), c('A', '♠')]);
  const pureSeq234 = getHandRank([c('2', '♥'), c('3', '♥'), c('4', '♥')]);
  const pureSeqA23 = getHandRank([c('A', '♦'), c('2', '♦'), c('3', '♦')]);
  const seq = getHandRank([c('10', '♠'), c('J', '♥'), c('Q', '♦')]);
  const color = getHandRank([c('A', '♣'), c('J', '♣'), c('5', '♣')]);
  const pairHighKicker = getHandRank([c('K', '♠'), c('K', '♥'), c('A', '♦')]);
  const pairLowKicker = getHandRank([c('K', '♣'), c('K', '♦'), c('2', '♠')]);
  const highCard = getHandRank([c('A', '♠'), c('Q', '♥'), c('9', '♦')]);

  assert.equal(trail.type, 'TRAIL');
  assert.equal(pureSeqQKA.type, 'PURE SEQUENCE');
  assert.equal(pureSeqA23.type, 'PURE SEQUENCE');
  assert.equal(seq.type, 'SEQUENCE');
  assert.equal(color.type, 'COLOR');
  assert.equal(pairHighKicker.type, 'PAIR');
  assert.equal(highCard.type, 'HIGH CARD');

  assert.ok(trail.score > pureSeqQKA.score);
  assert.ok(pureSeqQKA.score > pureSeq234.score);
  assert.ok(pureSeq234.score > pureSeqA23.score);
  assert.ok(pureSeqA23.score > seq.score);
  assert.ok(seq.score > color.score);
  assert.ok(color.score > pairHighKicker.score);
  assert.ok(pairHighKicker.score > pairLowKicker.score);
  assert.ok(pairLowKicker.score > highCard.score);
});

test('dealProvablyFairHands always produces unique non-tying hands with valid SHA-256 seedHash', () => {
  const crypto = require('crypto');
  for (let i = 0; i < 25; i++) {
    const roundId = `TEST-${i}`;
    const deal = dealProvablyFairHands(roundId);
    assert.equal(deal.cardsA.length, 3);
    assert.equal(deal.cardsB.length, 3);
    assert.notEqual(deal.rankA.score, deal.rankB.score);
    assert.ok(deal.winResult === 'A' || deal.winResult === 'B');
    const expectedHash = crypto.createHash('sha256').update(`${roundId}:${deal.serverSeed}`).digest('hex');
    assert.equal(deal.seedHash, expectedHash);
  }
});

test('Casino roundManager stays IDLE with 0 timers until playerReady, hides cards while open, and returns to IDLE on leave', async () => {
  roundManager._resetForTest();
  const mockIo = createMockIo();
  roundManager.initRoundManager(mockIo);

  // Passive state read does not start a round
  assert.equal(roundManager.TIMINGS.BETTING_DURATION, 15);
  assert.equal(roundManager.TIMINGS.REVEAL_DURATION, 5);
  assert.ok(roundManager.TIMINGS.RESULT_DURATION >= 4);

  const initialState = roundManager.getCurrentState();
  assert.equal(initialState.status, 'IDLE');
  assert.equal(initialState.roundId, null);
  assert.equal(mockIo.emitted.length, 0);

  // Concurrent socket + REST playerReady calls must never spawn duplicate round timers
  const sock = createMockSocket('cas-sock-1');
  const [state1, state2] = await Promise.all([
    roundManager.playerReady({ socket: sock, userId: 'player1' }),
    roundManager.playerReady({ userId: 'player1' }),
  ]);
  assert.equal(state1.status, 'DEALING');
  assert.equal(state1.roundId, state2.roundId);
  assert.equal(state1.activePlayers, 1);
  assert.ok(state1.roundId.startsWith('CAS-'));
  assert.ok(state1.seedHash);
  // Cards MUST be redacted until BETTING_CLOSED
  assert.deepEqual(state1.cards, { A: [null, null, null], B: [null, null, null] });
  assert.equal(state1.handNames, null);
  assert.equal(state1.serverSeed, null);
  // Emissions MUST be room-scoped to 'casino' (never 'GLOBAL')
  assert.ok(mockIo.emitted.every((e) => e.room === 'casino'));

  // Leave table stops engine immediately when no pending bets exist
  const leftState = roundManager.playerLeave({ socket: sock, userId: 'player1' });
  assert.equal(leftState.status, 'IDLE');
  roundManager._resetForTest();
});

test('TeenPatti manager handles Ready-to-Start lifecycle and Back/Lay/PairPlus evaluation math cleanly', async () => {
  teenPattiManager._resetForTest();
  const mockIo = createMockIo();
  teenPattiManager.initTeenPattiManager(mockIo);

  assert.equal(teenPattiManager.getCurrentState().status, 'IDLE');

  const sock = createMockSocket('tp-sock-1');
  const readyState = await teenPattiManager.playerReady({ socket: sock, userId: 'player2' });
  assert.equal(readyState.status, 'DEALING');
  assert.ok(readyState.roundId.startsWith('TP-'));
  assert.deepEqual(readyState.cards, { A: [null, null, null], B: [null, null, null] });
  assert.ok(mockIo.emitted.every((e) => e.room === 'teenpatti'));

  // Evaluate BACK win vs LAY risk/profit math
  const rankA = { type: 'PAIR' };
  const rankB = { type: 'HIGH CARD' };

  const backWin = teenPattiManager.evaluateBetOutcome(
    { betType: 'A_BACK', amount: 1000, odds: 1.98 },
    'A',
    rankA,
    rankB
  );
  assert.equal(backWin.isWin, true);
  assert.equal(backWin.risk, 1000);
  assert.equal(backWin.grossProfit, 980);

  const layWin = teenPattiManager.evaluateBetOutcome(
    { betType: 'B_LAY', amount: 1000, liability: 980, odds: 1.98 },
    'A', // Laying B when A wins => Bet wins!
    rankA,
    rankB
  );
  assert.equal(layWin.isWin, true);
  assert.equal(layWin.risk, 980);
  assert.equal(layWin.grossProfit, 1000);

  const pairPlusWin = teenPattiManager.evaluateBetOutcome(
    { betType: 'A_PAIR_PLUS', amount: 500, odds: 1.0 },
    'B', // Pair Plus on A still wins if A holds Pair even when B wins!
    { type: 'SEQUENCE' },
    { type: 'TRAIL' }
  );
  assert.equal(pairPlusWin.isWin, true);
  assert.equal(pairPlusWin.finalOdds, PAIR_PLUS_MULTIPLIERS.SEQUENCE);
  assert.equal(pairPlusWin.grossProfit, 3000);

  const leftState = teenPattiManager.playerLeave({ socket: sock, userId: 'player2' });
  assert.equal(leftState.status, 'IDLE');
  teenPattiManager._resetForTest();
});
