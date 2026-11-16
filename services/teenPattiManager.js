const crypto = require('crypto');
const TeenPattiHand = require('../models/TeenPattiHand');
const TeenPattiBet = require('../models/TeenPattiBet');
const User = require('../models/User');
const mongoose = require('mongoose');
const { distributeCasinoPL } = require('./hierarchyService');
const { validateBetLimit, capProfitByLimit } = require('./limitService');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const ROUND_SETTINGS = {
  DEALING_DURATION: 3,   // 3 seconds dealing phase to A & B
  BETTING_DURATION: 8,   // 8 seconds betting window (5-8s requested by user)
  SUSPENSE_DURATION: 4,  // 4 seconds progressive card reveal suspense (3-4s requested by user)
  RESULT_DURATION: 4,    // 4 seconds result display & celebration
  BACK_LAY_ODDS: 1.98,   // Exchange standard back/lay odds
};

// Pair Plus multipliers (standard 1 to X notation means payout multiplier = X + 1)
const PAIR_PLUS_MULTIPLIERS = {
  'TRAIL': 46.0,          // Trio: 1 to 45 (46x total payout)
  'PURE SEQUENCE': 36.0,  // Straight Flush: 1 to 35 (36x)
  'SEQUENCE': 7.0,        // Straight: 1 to 6 (7x)
  'COLOR': 5.0,           // Flush: 1 to 4 (5x)
  'PAIR': 2.0,            // Pair: 1 to 1 (2x)
};

// ═══════════════════════════════════════════════════════════════════════════
// MODULE STATE
// ═══════════════════════════════════════════════════════════════════════════
let io = null;
let currentRound = null;
let roundTimer = 0;
let phase = 'INIT'; // INIT, OPEN, CLOSED, RESULT
let timerInterval = null;
let isProcessing = false;
let history = [];
const activePlayers = new Set();

// ═══════════════════════════════════════════════════════════════════════════
// DECK & SHUFFLE
// ═══════════════════════════════════════════════════════════════════════════
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let i = 0; i < VALUES.length; i++) {
      deck.push({ value: VALUES[i], suit, rank: i });
    }
  }
  return deck;
}

function secureShuffle(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEEN PATTI HAND EVALUATOR
// ═══════════════════════════════════════════════════════════════════════════
function getHandRank(cards) {
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  const isTrail = ranks[0] === ranks[1] && ranks[1] === ranks[2];
  const isColor = suits[0] === suits[1] && suits[1] === suits[2];

  // Sequence detection (A-2-3 sequence special case)
  let isSequence = false;
  let sequenceRanks = ranks;

  if (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) {
    isSequence = true;
    sequenceRanks = ranks;
  } else if (ranks[0] === 12 && ranks[1] === 1 && ranks[2] === 0) {
    isSequence = true;
    sequenceRanks = [1, 0, -1]; // Lowest sequence ranking
  }

  const isPureSequence = isSequence && isColor;

  let pairRank = -1;
  let kicker = -1;
  if (ranks[0] === ranks[1]) {
    pairRank = ranks[0];
    kicker = ranks[2];
  } else if (ranks[1] === ranks[2]) {
    pairRank = ranks[1];
    kicker = ranks[0];
  } else if (ranks[0] === ranks[2]) {
    pairRank = ranks[0];
    kicker = ranks[1];
  }
  const isPair = pairRank >= 0 && !isTrail;

  if (isTrail) return { type: 'TRAIL', score: 50000 + ranks[0] };
  if (isPureSequence) return { type: 'PURE SEQUENCE', score: 40000 + sequenceRanks[0] };
  if (isSequence) return { type: 'SEQUENCE', score: 30000 + sequenceRanks[0] };
  if (isColor) return { type: 'COLOR', score: 20000 + ranks[0] * 100 + ranks[1] * 10 + ranks[2] };
  if (isPair) return { type: 'PAIR', score: 10000 + pairRank * 10 + kicker };
  return { type: 'HIGH CARD', score: ranks[0] * 100 + ranks[1] * 10 + ranks[2] };
}

// ═══════════════════════════════════════════════════════════════════════════
// BROADCAST STATE
// ═══════════════════════════════════════════════════════════════════════════
function broadcastState() {
  if (!io || !currentRound) return;

  let sanitizedCards = null;
  let sanitizedHandNames = null;

  if (currentRound.status === 'RESULT_DECLARED' || currentRound.status === 'BETTING_CLOSED') {
    sanitizedCards = currentRound.cards;
    sanitizedHandNames = currentRound.status === 'RESULT_DECLARED' ? currentRound.handNames : null;
  } else {
    sanitizedCards = {
      A: [null, null, null],
      B: [null, null, null]
    };
    sanitizedHandNames = null;
  }

  io.to('teenpatti').emit('teenpatti_state', {
    roundId: currentRound.roundId,
    status: currentRound.status,
    result: currentRound.status === 'RESULT_DECLARED' ? currentRound.result : 'PENDING',
    timer: roundTimer,
    cards: sanitizedCards,
    handNames: sanitizedHandNames,
    history,
    startTime: currentRound.startTime,
    endTime: currentRound.endTime,
    serverTimestamp: Date.now()
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET ROOM BOOT
// ═══════════════════════════════════════════════════════════════════════════
async function loadHistory() {
  try {
    const pastRounds = await TeenPattiHand.find({ status: 'RESULT_DECLARED' })
      .sort({ startTime: -1 })
      .limit(15);
    if (pastRounds && pastRounds.length > 0) {
      history = pastRounds.map(r => r.result).reverse();
    } else if (history.length === 0) {
      history = ['A', 'B', 'B', 'A', 'A', 'B', 'A', 'B', 'B', 'A'];
    }
  } catch (err) {
    console.warn('[TEENPATTI] Error loading history (using fallback):', err.message);
    if (history.length === 0) {
      history = ['A', 'B', 'B', 'A', 'A', 'B', 'A', 'B', 'B', 'A'];
    }
  }
}

function initTeenPattiManager(socketIo) {
  io = socketIo;
  loadHistory();

  // On boot, start in IDLE state. Engine runs ONLY when players are present and ready!
  phase = 'IDLE';

  io.on('connection', (socket) => {
    const handlePlayerReady = () => {
      socket.join('teenpatti');
      activePlayers.add(socket.id);
      console.log(`[TEENPATTI] Socket ${socket.id} joined/ready. Total: ${activePlayers.size}`);

      // Auto start game loop if game is idle or paused
      if (phase === 'IDLE' || phase === 'INIT' || !timerInterval) {
        startNewRound();
      } else if (currentRound) {
        let sanitizedCards = null;
        let sanitizedHandNames = null;

        if (currentRound.status === 'RESULT_DECLARED') {
          sanitizedCards = currentRound.cards;
          sanitizedHandNames = currentRound.handNames;
        } else {
          sanitizedCards = {
            A: [null, null, null],
            B: [null, null, null]
          };
          sanitizedHandNames = null;
        }

        socket.emit('teenpatti_state', {
          roundId: currentRound.roundId,
          status: currentRound.status,
          result: currentRound.status === 'RESULT_DECLARED' ? currentRound.result : 'PENDING',
          timer: roundTimer,
          cards: sanitizedCards,
          handNames: sanitizedHandNames,
          history
        });
      }
    };

    socket.on('join_teenpatti', handlePlayerReady);
    socket.on('teenpatti_ready', handlePlayerReady);

    const handlePlayerLeave = () => {
      socket.leave('teenpatti');
      activePlayers.delete(socket.id);
      console.log(`[TEENPATTI] Socket ${socket.id} left. Total: ${activePlayers.size}`);

      // If no players remain and game is currently in BETTING phase with no bets placed, pause to IDLE
      if (activePlayers.size === 0 && phase === 'OPEN') {
        TeenPattiBet.countDocuments({ roundId: currentRound?.roundId, status: 'PENDING' })
          .then(count => {
            if (count === 0 && activePlayers.size === 0 && phase === 'OPEN') {
              console.log('[TEENPATTI] All players left with no bets. Pausing engine to IDLE.');
              clearInterval(timerInterval);
              phase = 'IDLE';
              currentRound = null;
              broadcastState();
            }
          })
          .catch(() => {});
      }
    };

    socket.on('leave_teenpatti', handlePlayerLeave);
    socket.on('disconnect', handlePlayerLeave);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME LOOP FLOW
// ═══════════════════════════════════════════════════════════════════════════
async function startNewRound() {
  try {
    clearInterval(timerInterval);

    let cardsA, cardsB, rankA, rankB;
    do {
      const shuffledDeck = secureShuffle(createDeck());
      cardsA = shuffledDeck.slice(0, 3);
      cardsB = shuffledDeck.slice(3, 6);
      rankA = getHandRank(cardsA);
      rankB = getHandRank(cardsB);
    } while (rankA.score === rankB.score);

    const roundId = `TP-${Date.now()}`;
    const startTime = Date.now();
    const TOTAL_CYCLE = (ROUND_SETTINGS.DEALING_DURATION + ROUND_SETTINGS.BETTING_DURATION + ROUND_SETTINGS.SUSPENSE_DURATION + ROUND_SETTINGS.RESULT_DURATION) * 1000;
    const endTime = startTime + TOTAL_CYCLE;

    currentRound = {
      roundId,
      status: 'DEALING',
      startTime,
      endTime,
      result: 'PENDING',
      cards: { A: cardsA, B: cardsB },
      handNames: { A: rankA.type, B: rankB.type }
    };

    TeenPattiHand.create({
      roundId,
      status: 'DEALING',
      result: 'PENDING',
      cards: { A: cardsA, B: cardsB },
      handNames: { A: rankA.type, B: rankB.type }
    }).then(doc => {
      if (currentRound && currentRound.roundId === roundId) {
        currentRound._id = doc._id;
      }
    }).catch(e => console.warn('[TEENPATTI] DB save warning:', e.message));

    roundTimer = ROUND_SETTINGS.DEALING_DURATION || 5;
    phase = 'DEALING';
    console.log(`[TEENPATTI] Starting round ${roundId} (DEALING phase)`);

    const sanitizedRound = {
      roundId: currentRound.roundId,
      status: 'DEALING',
      result: 'PENDING',
      cards: { A: [null, null, null], B: [null, null, null] },
      handNames: null,
      timer: roundTimer
    };

    io.to('teenpatti').emit('teenpatti_round_start', sanitizedRound);
    broadcastState();

    timerInterval = setInterval(async () => {
      if (isProcessing) return;

      roundTimer--;
      broadcastState();

      if (roundTimer <= 0) {
        isProcessing = true;
        try {
          if (phase === 'DEALING') {
            // Transition to BETTING_OPEN
            phase = 'OPEN';
            roundTimer = ROUND_SETTINGS.BETTING_DURATION;
            currentRound.status = 'BETTING_OPEN';
            if (currentRound._id && mongoose.connection.readyState === 1) {
              await TeenPattiHand.updateOne({ _id: currentRound._id }, { $set: { status: 'BETTING_OPEN' } }).catch(e => console.warn('[TEENPATTI] DB update warning:', e.message));
            }
            broadcastState();
          } else if (phase === 'OPEN') {
            // Transition to BETTING_CLOSED
            phase = 'CLOSED';
            roundTimer = ROUND_SETTINGS.SUSPENSE_DURATION;
            currentRound.status = 'BETTING_CLOSED';
            if (currentRound._id && mongoose.connection.readyState === 1) {
              await TeenPattiHand.updateOne({ _id: currentRound._id }, { $set: { status: 'BETTING_CLOSED' } }).catch(e => console.warn('[TEENPATTI] DB update warning:', e.message));
            }
            
            const sanitizedClosedRound = {
              roundId: currentRound.roundId,
              status: currentRound.status,
              result: 'PENDING',
              cards: currentRound.cards,
              handNames: null,
              timer: roundTimer
            };
            io.to('teenpatti').emit('teenpatti_betting_closed', sanitizedClosedRound);
            broadcastState();
          } else if (phase === 'CLOSED') {
            clearInterval(timerInterval);
            timerInterval = null;
            await declareResult();
          }
        } catch (err) {
          console.error('[TEENPATTI] Error during phase transition:', err);
        } finally {
          isProcessing = false;
        }
      }
    }, 1000);
    if (timerInterval.unref) timerInterval.unref();

  } catch (err) {
    console.error('[TEENPATTI] Error starting new round:', err);
    setTimeout(startNewRound, 5000);
  }
}

async function declareResult() {
  if (!currentRound) return;

  try {
    phase = 'RESULT';
    
    // Evaluate results from pre-dealt cards
    const cardsA = currentRound.cards.A;
    const cardsB = currentRound.cards.B;
    const rankA = getHandRank(cardsA);
    const rankB = getHandRank(cardsB);

    const result = rankA.score > rankB.score ? 'A' : 'B';

    currentRound.result = result;
    currentRound.status = 'RESULT_DECLARED';
    if (currentRound._id && mongoose.connection.readyState === 1) {
      await TeenPattiHand.updateOne({ _id: currentRound._id }, { $set: { result, status: 'RESULT_DECLARED' } }).catch(e => console.warn('[TEENPATTI] DB result update warning:', e.message));
    }

    console.log(`[TEENPATTI] Round result: ${result} (A: ${rankA.type} vs B: ${rankB.type})`);
    
    // Update local history
    history.push(result);
    if (history.length > 15) history.shift();

    io.to('teenpatti').emit('teenpatti_result_declared', currentRound);
    broadcastState();

    // Settle bets
    await settleBets(result, rankA, rankB);

    // Start next round after result display duration only if players are active!
    setTimeout(() => {
      if (activePlayers.size > 0) {
        startNewRound();
      } else {
        console.log('[TEENPATTI] No active players. Pausing engine to IDLE.');
        phase = 'IDLE';
        currentRound = null;
        clearInterval(timerInterval);
        broadcastState();
      }
    }, ROUND_SETTINGS.RESULT_DURATION * 1000);

  } catch (err) {
    console.error('[TEENPATTI] Error declaring result:', err);
    if (activePlayers.size > 0) {
      setTimeout(startNewRound, 5000);
    } else {
      phase = 'IDLE';
      currentRound = null;
      broadcastState();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTLEMENT LOGIC
// ═══════════════════════════════════════════════════════════════════════════
async function settleBets(winningChoice, rankA, rankB) {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const bets = await TeenPattiBet.find({ roundId: currentRound.roundId, status: 'PENDING' });
    if (bets.length === 0) return;

    console.log(`[TEENPATTI AUDIT] Settling ${bets.length} bets for round ${currentRound.roundId}`);

    for (const bet of bets) {
      let isWin = false;
      let finalOdds = bet.odds;

      if (bet.betType === 'A_BACK' && winningChoice === 'A') isWin = true;
      else if (bet.betType === 'B_BACK' && winningChoice === 'B') isWin = true;
      else if (bet.betType === 'A_LAY' && winningChoice === 'B') isWin = true;
      else if (bet.betType === 'B_LAY' && winningChoice === 'A') isWin = true;
      else if (bet.betType === 'A_PAIR_PLUS') {
        const type = rankA.type;
        if (PAIR_PLUS_MULTIPLIERS[type]) {
          isWin = true;
          finalOdds = PAIR_PLUS_MULTIPLIERS[type];
        }
      } else if (bet.betType === 'B_PAIR_PLUS') {
        const type = rankB.type;
        if (PAIR_PLUS_MULTIPLIERS[type]) {
          isWin = true;
          finalOdds = PAIR_PLUS_MULTIPLIERS[type];
        }
      }

      if (isWin) {
        bet.status = 'WIN';
        // Profit calculation
        const grossProfit = bet.amount * (finalOdds - 1);
        const rawNetProfit = grossProfit * 0.98; // 2% platform commission
        const { netProfit } = await capProfitByLimit(bet.userId, 'teenpatti', rawNetProfit);
        const payout = bet.amount + netProfit;

        // Atomic wallet credit
        const user = await User.findOneAndUpdate(
          { username: bet.userId },
          { $inc: { walletBalance: payout } },
          { new: true }
        );

        // Distribute house loss up hierarchy
        await distributeCasinoPL(bet.userId, -netProfit, {
          matchName: `TeenPatti Round ${currentRound.roundId}`,
          selection: bet.betType
        });

        if (user) {
          io.emit('wallet_updated', { userId: bet.userId, balance: user.walletBalance });
          io.to('teenpatti').emit('teenpatti_payout', {
            userId: bet.userId,
            amount: payout,
            betType: bet.betType,
            result: 'WIN'
          });
        }
      } else {
        bet.status = 'LOSE';

        // Distribute house profit up hierarchy
        await distributeCasinoPL(bet.userId, bet.amount, {
          matchName: `TeenPatti Round ${currentRound.roundId}`,
          selection: bet.betType
        });

        io.to('teenpatti').emit('teenpatti_payout', {
          userId: bet.userId,
          amount: 0,
          betType: bet.betType,
          result: 'LOSE'
        });
      }

      await bet.save();
    }

  } catch (err) {
    console.error('[TEENPATTI] Error settling bets:', err);
  }
}

// ─── Deterministic Round Synchronization (Pure Vercel Serverless Resilient) ───────
function ensureLiveRound(now = Date.now()) {
  const TOTAL_CYCLE = (ROUND_SETTINGS.DEALING_DURATION + ROUND_SETTINGS.BETTING_DURATION + ROUND_SETTINGS.SUSPENSE_DURATION + ROUND_SETTINGS.RESULT_DURATION) * 1000; // 19000ms

  if (currentRound && currentRound.endTime && now < currentRound.endTime) {
    const elapsed = now - currentRound.startTime;
    const dealingEnd = ROUND_SETTINGS.DEALING_DURATION * 1000;
    const bettingEnd = dealingEnd + (ROUND_SETTINGS.BETTING_DURATION * 1000);
    const suspenseEnd = bettingEnd + (ROUND_SETTINGS.SUSPENSE_DURATION * 1000);

    if (elapsed < dealingEnd) {
      phase = 'OPEN';
      currentRound.status = 'DEALING';
      roundTimer = Math.ceil((bettingEnd - elapsed) / 1000);
    } else if (elapsed < bettingEnd) {
      phase = 'OPEN';
      currentRound.status = 'BETTING_OPEN';
      roundTimer = Math.ceil((bettingEnd - elapsed) / 1000);
    } else if (elapsed < suspenseEnd) {
      phase = 'CLOSED';
      currentRound.status = 'BETTING_CLOSED';
      roundTimer = 0;
    } else {
      phase = 'RESULT';
      currentRound.status = 'RESULT_DECLARED';
      currentRound.result = currentRound.winResult;
      roundTimer = 0;
      if (!currentRound.settled) {
        currentRound.settled = true;
        declareResult().catch(err => console.warn('[TEENPATTI SETTLE]', err.message));
      }
    }
    return currentRound;
  }

  // Generate new deterministic round
  const roundId = `TP-${now}`;
  const startTime = now;
  const endTime = startTime + TOTAL_CYCLE;

  let deck = createDeck();
  deck = secureShuffle(deck);

  const cardsA = deck.slice(0, 3);
  const cardsB = deck.slice(3, 6);
  const rankA = getHandRank(cardsA);
  const rankB = getHandRank(cardsB);

  let winResult = 'A';
  if (rankA.score > rankB.score) {
    winResult = 'A';
  } else if (rankB.score > rankA.score) {
    winResult = 'B';
  } else {
    winResult = 'TIE';
  }

  currentRound = {
    roundId,
    status: 'BETTING_OPEN',
    startTime,
    endTime,
    result: 'PENDING',
    cards: { A: cardsA, B: cardsB },
    handNames: { A: rankA.type, B: rankB.type },
    winResult,
    settled: false
  };

  phase = 'OPEN';
  roundTimer = ROUND_SETTINGS.BETTING_DURATION;

  if (mongoose.connection.readyState === 1) {
    TeenPattiHand.create({
      roundId,
      status: 'BETTING_OPEN',
      startTime: new Date(startTime),
      cards: currentRound.cards,
      handNames: currentRound.handNames,
      result: 'PENDING'
    }).catch(err => console.warn('[TEENPATTI] DB save warning:', err.message));
  }

  return currentRound;
}

function getCurrentState(now = Date.now()) {
  const round = ensureLiveRound(now);
  let sanitizedCards = null;
  let sanitizedHandNames = null;

  if (round.status === 'RESULT_DECLARED' || round.status === 'BETTING_CLOSED') {
    sanitizedCards = round.cards;
    sanitizedHandNames = round.status === 'RESULT_DECLARED' ? round.handNames : null;
  } else {
    sanitizedCards = {
      A: [null, null, null],
      B: [null, null, null]
    };
    sanitizedHandNames = null;
  }

  return {
    roundId: round.roundId,
    status: round.status,
    result: round.status === 'RESULT_DECLARED' ? round.winResult : 'PENDING',
    timer: roundTimer,
    cards: sanitizedCards,
    handNames: sanitizedHandNames,
    history: history.length > 0 ? history : ['A', 'B', 'A', 'A', 'B', 'B', 'A'],
    serverTimestamp: now
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
async function placeBet(userId, betType, amount) {
  const now = Date.now();
  const round = ensureLiveRound(now);

  if (round.status !== 'BETTING_OPEN' && round.status !== 'DEALING') {
    throw new Error('Betting is currently closed');
  }

  if (!amount || isNaN(amount) || amount < 10) {
    throw new Error('Invalid stake amount (minimum 10)');
  }

  // Validate hierarchical max bet size & profit limit for Teen Patti
  const estimatedProfit = amount * (ROUND_SETTINGS.BACK_LAY_ODDS - 1);
  await validateBetLimit(userId, 'teenpatti', amount, estimatedProfit);

  // Deduct balance atomically
  const user = await User.findOneAndUpdate(
    { username: userId, walletBalance: { $gte: amount } },
    { $inc: { walletBalance: -amount } },
    { new: true }
  );

  if (!user) {
    throw new Error('Insufficient wallet balance');
  }

  // Determine standard odds for the bet
  let odds = ROUND_SETTINGS.BACK_LAY_ODDS;
  if (betType.includes('PAIR_PLUS')) {
    odds = 1.0; // Payout multiplier is dynamic based on winner rank
  }

  const bet = new TeenPattiBet({
    userId,
    roundId: round.roundId,
    betType,
    amount,
    odds,
    status: 'PENDING'
  });
  await bet.save();

  if (io) {
    io.emit('wallet_updated', { userId, balance: user.walletBalance });
    io.to('teenpatti').emit('teenpatti_bet_placed', {
      userId,
      betType,
      amount,
      odds
    });
  }

  return { success: true, balance: user.walletBalance, bet };
}

function getActiveRound() {
  return currentRound || ensureLiveRound(Date.now());
}

module.exports = {
  initTeenPattiManager,
  ensureLiveRound,
  getCurrentState,
  placeBet,
  getActiveRound,
  getHandRank
};
