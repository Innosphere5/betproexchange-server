const crypto = require('crypto');
const TeenPattiHand = require('../models/TeenPattiHand');
const TeenPattiBet = require('../models/TeenPattiBet');
const User = require('../models/User');
const { distributeCasinoPL } = require('./hierarchyService');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const ROUND_SETTINGS = {
  DEALING_DURATION: 5,   // 5 seconds dealing phase
  BETTING_DURATION: 20,  // 20 seconds betting window
  SUSPENSE_DURATION: 3,  // 3 seconds betting closed suspense
  RESULT_DURATION: 10,   // 10 seconds result display (to allow progressive reveal animation)
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

  io.to('teenpatti').emit('teenpatti_state', {
    roundId: currentRound.roundId,
    status: currentRound.status,
    result: currentRound.status === 'RESULT_DECLARED' ? currentRound.result : 'PENDING',
    timer: roundTimer,
    cards: sanitizedCards,
    handNames: sanitizedHandNames,
    history
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
    history = pastRounds.map(r => r.result).reverse();
  } catch (err) {
    console.error('[TEENPATTI] Error loading history:', err);
  }
}

function initTeenPattiManager(socketIo) {
  io = socketIo;
  loadHistory();

  io.on('connection', (socket) => {
    socket.on('join_teenpatti', () => {
      socket.join('teenpatti');
      activePlayers.add(socket.id);
      console.log(`[TEENPATTI] Socket ${socket.id} joined. Total: ${activePlayers.size}`);

      // Immediately sync state
      if (currentRound) {
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

      // Auto start game loop if first player
      if (activePlayers.size === 1 && phase === 'INIT') {
        startNewRound();
      }
    });

    socket.on('leave_teenpatti', () => {
      socket.leave('teenpatti');
      activePlayers.delete(socket.id);
      console.log(`[TEENPATTI] Socket ${socket.id} left. Total: ${activePlayers.size}`);
    });

    socket.on('disconnect', () => {
      activePlayers.delete(socket.id);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME LOOP FLOW
// ═══════════════════════════════════════════════════════════════════════════
async function startNewRound() {
  if (activePlayers.size === 0) {
    console.log('[TEENPATTI] No active players. Pausing engine loop...');
    phase = 'INIT';
    currentRound = null;
    return;
  }

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
    currentRound = new TeenPattiHand({
      roundId,
      status: 'DEALING',
      result: 'PENDING',
      cards: { A: cardsA, B: cardsB },
      handNames: { A: rankA.type, B: rankB.type }
    });
    await currentRound.save();

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
      roundTimer--;
      broadcastState();

      if (roundTimer <= 0) {
        if (phase === 'DEALING') {
          // Transition to BETTING_OPEN
          phase = 'OPEN';
          currentRound.status = 'BETTING_OPEN';
          await currentRound.save();
          roundTimer = ROUND_SETTINGS.BETTING_DURATION;
          broadcastState();
        } else if (phase === 'OPEN') {
          // Transition to BETTING_CLOSED
          phase = 'CLOSED';
          currentRound.status = 'BETTING_CLOSED';
          await currentRound.save();
          
          const sanitizedClosedRound = {
            roundId: currentRound.roundId,
            status: currentRound.status,
            result: 'PENDING',
            cards: { A: [null, null, null], B: [null, null, null] },
            handNames: null
          };
          io.to('teenpatti').emit('teenpatti_betting_closed', sanitizedClosedRound);
          broadcastState();

          roundTimer = ROUND_SETTINGS.SUSPENSE_DURATION;
        } else if (phase === 'CLOSED') {
          clearInterval(timerInterval);
          await declareResult();
        }
      }
    }, 1000);

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
    await currentRound.save();

    console.log(`[TEENPATTI] Round result: ${result} (A: ${rankA.type} vs B: ${rankB.type})`);
    
    // Update local history
    history.push(result);
    if (history.length > 15) history.shift();

    io.to('teenpatti').emit('teenpatti_result_declared', currentRound);
    broadcastState();

    // Settle bets
    await settleBets(result, rankA, rankB);

    // Start next round after result display duration
    setTimeout(() => {
      startNewRound();
    }, ROUND_SETTINGS.RESULT_DURATION * 1000);

  } catch (err) {
    console.error('[TEENPATTI] Error declaring result:', err);
    setTimeout(startNewRound, 5000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTLEMENT LOGIC
// ═══════════════════════════════════════════════════════════════════════════
async function settleBets(winningChoice, rankA, rankB) {
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
        const netProfit = grossProfit * 0.95; // 5% house commission
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

// ═══════════════════════════════════════════════════════════════════════════
// API HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
async function placeBet(userId, betType, amount) {
  if (!currentRound || phase !== 'OPEN') {
    throw new Error('Betting is currently closed');
  }

  if (!amount || isNaN(amount) || amount < 10) {
    throw new Error('Invalid stake amount (minimum 10)');
  }

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
    roundId: currentRound.roundId,
    betType,
    amount,
    odds,
    status: 'PENDING'
  });
  await bet.save();

  io.emit('wallet_updated', { userId, balance: user.walletBalance });
  
  // Send state update
  io.to('teenpatti').emit('teenpatti_bet_placed', {
    userId,
    betType,
    amount,
    odds
  });

  return { success: true, balance: user.walletBalance, bet };
}

function getActiveRound() {
  return currentRound;
}

module.exports = {
  initTeenPattiManager,
  placeBet,
  getActiveRound,
  getHandRank
};
