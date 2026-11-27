const mongoose = require('mongoose');
const TeenPattiHand = require('../models/TeenPattiHand');
const TeenPattiBet = require('../models/TeenPattiBet');
const { distributeCasinoPL } = require('./hierarchyService');
const { validateBetLimit, capProfitByLimit } = require('./limitService');
const {
  PAIR_PLUS_MULTIPLIERS,
  round2,
  getHandRank,
  dealProvablyFairHands,
  debitPlayerWallet,
  creditPlayerWallet,
} = require('./cardGameEngine');

const ROOM_NAME = 'teenpatti';
const REST_PLAYER_TTL_MS = 45000;
const MAX_HISTORY_ITEMS = 24;

const ROUND_SETTINGS = {
  DEALING_DURATION: 2,   // 2s card split animation
  BETTING_DURATION: 10,  // 10s exchange Back/Lay & Pair Plus betting window
  SUSPENSE_DURATION: 4,  // 4s progressive 3-card reveal
  RESULT_DURATION: 3,    // 3s winner celebration before next round or IDLE
  BACK_LAY_ODDS: 1.98,
};

let io = null;
let currentRound = null;
let roundTimer = 0;
let phaseEndsAt = 0;
let phase = 'IDLE'; // IDLE | DEALING | OPEN | CLOSED | RESULT
let timerInterval = null;
let nextRoundTimeout = null;
let isStartingRound = false;
let isTickProcessing = false;
let isSettling = false;
let historyLoaded = false;

const activeSockets = new Map(); // socket.id -> userId | null
const activeUsers = new Map();
let roundBets = [];
let history = []; // Capped array of { roundId, result, handA, handB, seedHash }

function clearTimers() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (nextRoundTimeout) {
    clearTimeout(nextRoundTimeout);
    nextRoundTimeout = null;
  }
}

function pruneStaleRestPlayers(now = Date.now()) {
  for (const [userId, ts] of activeUsers.entries()) {
    if (now - ts > REST_PLAYER_TTL_MS) {
      activeUsers.delete(userId);
    }
  }
}

function getActivePlayerCount(now = Date.now()) {
  pruneStaleRestPlayers(now);
  const uniqueIds = new Set();
  for (const userId of activeUsers.keys()) {
    uniqueIds.add(`u:${userId}`);
  }
  for (const [sockId, userId] of activeSockets.entries()) {
    uniqueIds.add(userId ? `u:${userId}` : `s:${sockId}`);
  }
  const roomSize = io?.sockets?.adapter?.rooms?.get(ROOM_NAME)?.size || 0;
  return Math.max(uniqueIds.size, roomSize > 0 && uniqueIds.size === 0 ? roomSize : 0);
}

function hasActivePlayers(now = Date.now()) {
  return getActivePlayerCount(now) > 0;
}

async function ensureHistoryLoaded() {
  if (historyLoaded) return;
  historyLoaded = true;
  if (mongoose.connection.readyState !== 1) return;
  try {
    const past = await TeenPattiHand.find({ status: 'RESULT_DECLARED' })
      .sort({ startTime: -1 })
      .limit(MAX_HISTORY_ITEMS)
      .select('roundId result handNames seedHash startTime')
      .lean();
    if (Array.isArray(past) && past.length > 0) {
      history = past.map((r) => ({
        roundId: r.roundId,
        result: r.result,
        handA: r.handNames?.A || '',
        handB: r.handNames?.B || '',
        seedHash: r.seedHash || null,
      }));
    }
  } catch (err) {
    console.warn('[TEENPATTI] History preload warning:', err.message);
  }
}

function sanitizeRoundForClient(round, now = Date.now()) {
  if (!round || phase === 'IDLE') {
    return {
      roundId: null,
      status: 'IDLE',
      result: 'PENDING',
      timer: 0,
      maxTimer: 0,
      cards: { A: [null, null, null], B: [null, null, null] },
      handNames: null,
      seedHash: null,
      serverSeed: null,
      history: history.map((h) => h.result),
      detailedHistory: history,
      activePlayers: getActivePlayerCount(now),
      serverTimestamp: now,
    };
  }

  const revealCards = round.status === 'BETTING_CLOSED' || round.status === 'RESULT_DECLARED';
  const revealResult = round.status === 'RESULT_DECLARED';
  const liveRemaining = phaseEndsAt > 0
    ? Math.max(0, Math.ceil((phaseEndsAt - now) / 1000))
    : Math.max(0, roundTimer);

  return {
    roundId: round.roundId,
    status: round.status,
    result: revealResult ? round.result : 'PENDING',
    timer: liveRemaining,
    maxTimer:
      round.status === 'DEALING'
        ? ROUND_SETTINGS.DEALING_DURATION
        : round.status === 'BETTING_OPEN'
          ? ROUND_SETTINGS.BETTING_DURATION
          : round.status === 'BETTING_CLOSED'
            ? ROUND_SETTINGS.SUSPENSE_DURATION
            : ROUND_SETTINGS.RESULT_DURATION,
    cards: revealCards
      ? round.cards
      : { A: [null, null, null], B: [null, null, null] },
    handNames: revealResult ? round.handNames : null,
    seedHash: round.seedHash || null,
    serverSeed: revealResult ? round.serverSeed : null,
    history: history.map((h) => h.result),
    detailedHistory: history,
    activePlayers: getActivePlayerCount(now),
    startTime: round.startTime,
    endTime: round.endTime,
    serverTimestamp: now,
  };
}

function broadcastState(targetSocket = null) {
  const payload = sanitizeRoundForClient(currentRound, Date.now());
  if (targetSocket) {
    targetSocket.emit('teenpatti_state', payload);
    return;
  }
  if (io) {
    io.to(ROOM_NAME).emit('teenpatti_state', payload);
  }
}

function transitionToIdle() {
  clearTimers();
  phase = 'IDLE';
  currentRound = null;
  roundTimer = 0;
  roundBets = [];
  isTickProcessing = false;
  broadcastState();
}

/**
 * Computes settlement outcome & payout for one Teen Patti bet.
 */
function evaluateBetOutcome(bet, winningChoice, rankA, rankB) {
  let isWin = false;
  let finalOdds = bet.odds || ROUND_SETTINGS.BACK_LAY_ODDS;
  const stake = bet.amount;
  const risk = bet.liability != null
    ? bet.liability
    : (bet.betType === 'A_LAY' || bet.betType === 'B_LAY' ? round2(stake * (finalOdds - 1)) : stake);

  if (bet.betType === 'A_BACK' && winningChoice === 'A') isWin = true;
  else if (bet.betType === 'B_BACK' && winningChoice === 'B') isWin = true;
  else if (bet.betType === 'A_LAY' && winningChoice === 'B') isWin = true;
  else if (bet.betType === 'B_LAY' && winningChoice === 'A') isWin = true;
  else if (bet.betType === 'A_PAIR_PLUS' && PAIR_PLUS_MULTIPLIERS[rankA?.type]) {
    isWin = true;
    finalOdds = PAIR_PLUS_MULTIPLIERS[rankA.type];
  } else if (bet.betType === 'B_PAIR_PLUS' && PAIR_PLUS_MULTIPLIERS[rankB?.type]) {
    isWin = true;
    finalOdds = PAIR_PLUS_MULTIPLIERS[rankB.type];
  }

  if (!isWin) {
    return { isWin: false, risk, grossProfit: 0, payout: 0, finalOdds };
  }

  const isLay = bet.betType === 'A_LAY' || bet.betType === 'B_LAY';
  const grossProfit = isLay ? round2(stake) : round2(stake * (finalOdds - 1));
  return { isWin: true, risk, grossProfit, finalOdds };
}

async function settleBets(round) {
  if (!round || isSettling) return;
  isSettling = true;

  try {
    const winResult = round.winResult;
    const rankA = getHandRank(round.cards.A);
    const rankB = getHandRank(round.cards.B);

    round.result = winResult;
    round.status = 'RESULT_DECLARED';

    const entry = {
      roundId: round.roundId,
      result: winResult,
      handA: round.handNames?.A || rankA.type,
      handB: round.handNames?.B || rankB.type,
      seedHash: round.seedHash || null,
    };
    history = [entry, ...history.filter((h) => h.roundId !== round.roundId)].slice(0, MAX_HISTORY_ITEMS);

    if (io) {
      io.to(ROOM_NAME).emit('teenpatti_result_declared', {
        roundId: round.roundId,
        status: 'RESULT_DECLARED',
        result: winResult,
        cards: round.cards,
        handNames: round.handNames,
        seedHash: round.seedHash,
        serverSeed: round.serverSeed,
        history: history.map((h) => h.result),
        detailedHistory: history,
      });
    }

    const betsToSettle = [...roundBets];
    roundBets = [];

    if (mongoose.connection.readyState === 1) {
      const dbBets = await TeenPattiBet.find({ roundId: round.roundId, status: 'PENDING' });
      for (const dbBet of dbBets) {
        if (!betsToSettle.some((b) => String(b._id) === String(dbBet._id))) {
          betsToSettle.push(dbBet);
        }
      }

      if (betsToSettle.length > 0) {
        await TeenPattiHand.findOneAndUpdate(
          { roundId: round.roundId },
          {
            $set: {
              status: 'RESULT_DECLARED',
              result: winResult,
              cards: round.cards,
              handNames: round.handNames,
              seedHash: round.seedHash,
              startTime: new Date(round.startTime),
            },
          },
          { upsert: true }
        ).catch(() => {});
      }
    }

    for (const bet of betsToSettle) {
      const outcome = evaluateBetOutcome(bet, winResult, rankA, rankB);

      if (outcome.isWin) {
        const rawNetProfit = round2(outcome.grossProfit * 0.98); // 2% platform commission on profit
        const { netProfit } = await capProfitByLimit(bet.userId, 'teenpatti', rawNetProfit);
        const cappedNet = round2(netProfit);
        const payout = round2(outcome.risk + cappedNet);

        await creditPlayerWallet(bet.userId, payout, io);

        distributeCasinoPL(bet.userId, -cappedNet, {
          matchName: `TeenPatti Round ${round.roundId}`,
          selection: bet.betType,
        }).catch(() => {});

        if (io) {
          const payload = {
            userId: bet.userId,
            roundId: round.roundId,
            amount: payout,
            profit: cappedNet,
            betType: bet.betType,
            result: 'WIN',
          };
          io.to(`user:${bet.userId}`).emit('teenpatti_payout', payload);
          io.to(`user:${String(bet.userId).toLowerCase()}`).emit('teenpatti_payout', payload);
        }

        if (mongoose.connection.readyState === 1 && bet._id) {
          TeenPattiBet.findByIdAndUpdate(bet._id, { status: 'WIN', payout }).catch(() => {});
        }
      } else {
        distributeCasinoPL(bet.userId, outcome.risk, {
          matchName: `TeenPatti Round ${round.roundId}`,
          selection: bet.betType,
        }).catch(() => {});

        if (io) {
          const payload = {
            userId: bet.userId,
            roundId: round.roundId,
            amount: outcome.risk,
            profit: -outcome.risk,
            betType: bet.betType,
            result: 'LOSE',
          };
          io.to(`user:${bet.userId}`).emit('teenpatti_payout', payload);
          io.to(`user:${String(bet.userId).toLowerCase()}`).emit('teenpatti_payout', payload);
        }

        if (mongoose.connection.readyState === 1 && bet._id) {
          TeenPattiBet.findByIdAndUpdate(bet._id, { status: 'LOSE', payout: 0 }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[TEENPATTI] Settlement error:', err.message);
  } finally {
    isSettling = false;
  }
}

async function startNewRound() {
  if (isStartingRound) {
    return sanitizeRoundForClient(currentRound, Date.now());
  }
  if (!hasActivePlayers()) {
    transitionToIdle();
    return null;
  }

  isStartingRound = true;
  clearTimers();

  try {
    await ensureHistoryLoaded();
    if (!hasActivePlayers()) {
      transitionToIdle();
      return null;
    }

    const startTime = Date.now();
    const roundId = `TP-${startTime}`;
    const deal = dealProvablyFairHands(roundId);
    const totalCycleMs =
      (ROUND_SETTINGS.DEALING_DURATION +
        ROUND_SETTINGS.BETTING_DURATION +
        ROUND_SETTINGS.SUSPENSE_DURATION +
        ROUND_SETTINGS.RESULT_DURATION) *
      1000;

    currentRound = {
      roundId,
      status: 'DEALING',
      startTime,
      endTime: startTime + totalCycleMs,
      result: 'PENDING',
      cards: { A: deal.cardsA, B: deal.cardsB },
      handNames: { A: deal.rankA.type, B: deal.rankB.type },
      winResult: deal.winResult,
      seedHash: deal.seedHash,
      serverSeed: deal.serverSeed,
    };

    phase = 'DEALING';
    roundTimer = ROUND_SETTINGS.DEALING_DURATION;
    phaseEndsAt = startTime + ROUND_SETTINGS.DEALING_DURATION * 1000;
    roundBets = [];

    clearTimers();
    const payload = sanitizeRoundForClient(currentRound, startTime);
    if (io) {
      io.to(ROOM_NAME).emit('teenpatti_round_start', payload);
    }
    broadcastState();

    timerInterval = setInterval(async () => {
      if (isTickProcessing || !currentRound) return;
      isTickProcessing = true;

      try {
        const now = Date.now();
        roundTimer = Math.max(0, Math.ceil((phaseEndsAt - now) / 1000));

        if (now >= phaseEndsAt) {
          if (phase === 'DEALING') {
            phase = 'OPEN';
            currentRound.status = 'BETTING_OPEN';
            roundTimer = ROUND_SETTINGS.BETTING_DURATION;
            phaseEndsAt = now + ROUND_SETTINGS.BETTING_DURATION * 1000;
            broadcastState();
          } else if (phase === 'OPEN') {
            phase = 'CLOSED';
            currentRound.status = 'BETTING_CLOSED';
            roundTimer = ROUND_SETTINGS.SUSPENSE_DURATION;
            phaseEndsAt = now + ROUND_SETTINGS.SUSPENSE_DURATION * 1000;
            const closedState = sanitizeRoundForClient(currentRound, now);
            if (io) {
              io.to(ROOM_NAME).emit('teenpatti_betting_closed', closedState);
            }
            broadcastState();
          } else if (phase === 'CLOSED') {
            clearTimers();
            phase = 'RESULT';
            currentRound.status = 'RESULT_DECLARED';
            roundTimer = ROUND_SETTINGS.RESULT_DURATION;
            phaseEndsAt = now + ROUND_SETTINGS.RESULT_DURATION * 1000;
            await settleBets(currentRound);
            broadcastState();

            nextRoundTimeout = setTimeout(() => {
              if (hasActivePlayers()) {
                startNewRound().catch((err) => {
                  console.error('[TEENPATTI] Next round start error:', err.message);
                  transitionToIdle();
                });
              } else {
                transitionToIdle();
              }
            }, ROUND_SETTINGS.RESULT_DURATION * 1000);
            if (nextRoundTimeout.unref) nextRoundTimeout.unref();
          }
        } else {
          broadcastState();
        }
      } catch (err) {
        console.error('[TEENPATTI] Ticker error:', err.message);
      } finally {
        isTickProcessing = false;
      }
    }, 1000);

    if (timerInterval.unref) timerInterval.unref();
    return payload;
  } finally {
    isStartingRound = false;
  }
}

function initTeenPattiManager(socketIo) {
  io = socketIo;
  clearTimers();
  isStartingRound = false;
  phase = 'IDLE';
  currentRound = null;
  roundTimer = 0;
  phaseEndsAt = 0;
  roundBets = [];
  console.log('[TEENPATTI] Ready-to-Start on-demand engine initialized (IDLE, 0 background CPU).');
}

async function playerReady({ socket = null, userId = null } = {}) {
  const normUser = userId ? String(userId).trim() : null;
  if (socket) {
    socket.join(ROOM_NAME);
    const existingUid = activeSockets.get(socket.id) || normUser;
    activeSockets.set(socket.id, existingUid || null);
    if (normUser) socket.teenPattiUserId = normUser;
  }
  if (normUser) {
    activeUsers.set(normUser, Date.now());
  }

  if (phase === 'IDLE' || !currentRound) {
    await startNewRound();
  } else {
    broadcastState(socket);
  }

  return sanitizeRoundForClient(currentRound, Date.now());
}

function playerLeave({ socket = null, userId = null } = {}) {
  const effectiveUserId = userId || socket?.teenPattiUserId;
  if (socket) {
    socket.leave(ROOM_NAME);
    activeSockets.delete(socket.id);
    socket.teenPattiUserId = null;
  }
  if (effectiveUserId) {
    activeUsers.delete(String(effectiveUserId).trim());
  }

  if (!hasActivePlayers() && roundBets.length === 0) {
    transitionToIdle();
  }

  return sanitizeRoundForClient(currentRound, Date.now());
}

function handleSocketDisconnect(socket) {
  if (!socket) return;
  const uid = activeSockets.get(socket.id) || socket.teenPattiUserId;
  activeSockets.delete(socket.id);
  if (uid) {
    const stillSocketed = Array.from(activeSockets.values()).some((id) => id === uid);
    if (!stillSocketed) {
      activeUsers.delete(String(uid).trim());
    }
  }
  if (!hasActivePlayers() && roundBets.length === 0) {
    transitionToIdle();
  }
}

function getCurrentState(now = Date.now(), { viewerUserId = null } = {}) {
  if (viewerUserId && activeUsers.has(String(viewerUserId))) {
    activeUsers.set(String(viewerUserId), now);
  }
  return sanitizeRoundForClient(currentRound, now);
}

const VALID_BET_TYPES = new Set([
  'A_BACK',
  'A_LAY',
  'B_BACK',
  'B_LAY',
  'A_PAIR_PLUS',
  'B_PAIR_PLUS',
]);

async function placeBet(userId, betType, amount) {
  if (!currentRound || phase === 'IDLE') {
    throw new Error('Click Ready to Start before placing bets');
  }
  if (currentRound.status !== 'BETTING_OPEN') {
    throw new Error('Betting is currently closed');
  }
  if (!VALID_BET_TYPES.has(betType)) {
    throw new Error('Invalid bet type');
  }

  const stake = round2(parseFloat(amount));
  if (!stake || isNaN(stake) || stake < 10) {
    throw new Error('Minimum stake amount is ₹10');
  }

  activeUsers.set(String(userId), Date.now());

  const isLay = betType === 'A_LAY' || betType === 'B_LAY';
  const isPairPlus = betType.includes('PAIR_PLUS');
  const odds = isPairPlus ? 1.0 : ROUND_SETTINGS.BACK_LAY_ODDS;
  const riskAmount = isLay ? round2(stake * (odds - 1)) : stake;
  const estimatedProfit = isLay
    ? stake
    : isPairPlus
      ? round2(stake * (PAIR_PLUS_MULTIPLIERS.PAIR - 1))
      : round2(stake * (odds - 1));

  await validateBetLimit(userId, 'teenpatti', riskAmount, estimatedProfit);
  const walletResult = await debitPlayerWallet(userId, riskAmount, io);

  const bet = new TeenPattiBet({
    userId,
    roundId: currentRound.roundId,
    betType,
    amount: stake,
    liability: riskAmount,
    odds,
    status: 'PENDING',
  });
  await bet.save();

  roundBets.push({
    _id: bet._id,
    userId,
    roundId: currentRound.roundId,
    betType,
    amount: stake,
    liability: riskAmount,
    odds,
    status: 'PENDING',
  });

  if (io) {
    io.to(ROOM_NAME).emit('teenpatti_bet_placed', {
      userId,
      betType,
      amount: stake,
      liability: riskAmount,
      odds,
      roundId: currentRound.roundId,
    });
  }

  return {
    success: true,
    balance: walletResult.effectiveBalance,
    bet,
  };
}

function getActiveRound() {
  return currentRound;
}

function getHistory() {
  return history;
}

function _resetForTest() {
  clearTimers();
  activeSockets.clear();
  activeUsers.clear();
  currentRound = null;
  phase = 'IDLE';
  roundTimer = 0;
  phaseEndsAt = 0;
  roundBets = [];
  history = [];
  historyLoaded = false;
  isStartingRound = false;
  isTickProcessing = false;
  isSettling = false;
  io = null;
}

module.exports = {
  ROUND_SETTINGS,
  PAIR_PLUS_MULTIPLIERS,
  initTeenPattiManager,
  playerReady,
  playerLeave,
  handleSocketDisconnect,
  getCurrentState,
  getActiveRound,
  getHistory,
  placeBet,
  getHandRank,
  evaluateBetOutcome,
  _resetForTest,
};
