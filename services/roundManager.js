const CasinoRound = require('../models/CasinoRound');
const CasinoBet = require('../models/CasinoBet');
const User = require('../models/User');
const { distributeCasinoPL } = require('./hierarchyService');

let io = null;
let currentRound = null;
let roundTimer = 0;
let phase = 'INIT'; // INIT, DEALING, OPEN, CLOSED, RESULT
let timerInterval = null;
let isProcessingResult = false;
let isStartingRound = false;

const activePlayers = new Set(); // Track socket IDs that have "joined" the casino

function broadcastState() {
  if (!io || !currentRound) return;
  io.emit('casino_state', {
    roundId: currentRound.roundId,
    status: currentRound.status,
    result: currentRound.result,
    timer: roundTimer,
    cards: currentRound.cards || null,
    handNames: currentRound.handNames || null
  });
}

function initRoundManager(socketIo) {
  io = socketIo;

  io.on('connection', (socket) => {
    console.log(`[CASINO] Socket connected: ${socket.id}`);

    // Send current state on connection
    if (currentRound) {
      socket.emit('casino_state', {
        roundId: currentRound.roundId,
        status: currentRound.status,
        result: currentRound.result,
        timer: roundTimer,
        cards: currentRound.cards || null,
        handNames: currentRound.handNames || null
      });
    }

    socket.on('join_casino', () => {
      activePlayers.add(socket.id);
      console.log(`[CASINO] Socket ${socket.id} joined casino. Active: ${activePlayers.size}`);

      // Launch rounds if players active and no round running
      if (activePlayers.size >= 1 && (!currentRound || currentRound.status === 'RESULT_DECLARED') && !isStartingRound) {
        console.log("[CASINO] Player joined, initiating casino round sequence...");
        startNewRound();
      }
    });

    socket.on('leave_casino', () => {
      activePlayers.delete(socket.id);
      console.log(`[CASINO] Socket ${socket.id} left casino. Active: ${activePlayers.size}`);
    });

    socket.on('disconnect', () => {
      activePlayers.delete(socket.id);
      console.log(`[CASINO] Socket ${socket.id} disconnected. Active: ${activePlayers.size}`);
    });
  });
}

function getHandRank(cards) {
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  const isTrail = ranks[0] === ranks[1] && ranks[1] === ranks[2];
  const isColor = suits[0] === suits[1] && suits[1] === suits[2];

  const isSequence = (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) ||
    (ranks[0] === 12 && ranks[1] === 1 && ranks[2] === 0); // A-2-3

  const isPureSequence = isSequence && isColor;
  const isPair = ranks[0] === ranks[1] || ranks[1] === ranks[2] || ranks[0] === ranks[2];

  if (isTrail) return { type: 'TRAIL', score: 5000 + ranks[0] };
  if (isPureSequence) return { type: 'PURE SEQUENCE', score: 4000 + ranks[0] };
  if (isSequence) return { type: 'SEQUENCE', score: 3000 + ranks[0] };
  if (isColor) return { type: 'COLOR', score: 2000 + ranks[0] * 100 + ranks[1] * 10 + ranks[2] };
  if (isPair) {
    const pairRank = (ranks[0] === ranks[1]) ? ranks[0] : (ranks[1] === ranks[2] ? ranks[1] : ranks[0]);
    const kicker = (ranks[0] === ranks[1]) ? ranks[2] : (ranks[1] === ranks[2] ? ranks[0] : ranks[1]);
    return { type: 'PAIR', score: 1000 + pairRank * 10 + kicker };
  }
  return { type: 'HIGH CARD', score: ranks[0] * 100 + ranks[1] * 10 + ranks[2] };
}

async function startNewRound() {
  if (isStartingRound) return;
  if (activePlayers.size === 0) {
    console.log("[CASINO] No active players. Casino idling...");
    currentRound = null;
    return;
  }

  isStartingRound = true;

  // Clear existing timer if any
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  try {
    const roundId = `RND-${Date.now()}`;
    
    // Create new round record in DB
    const newDoc = await CasinoRound.create({ 
      roundId, 
      status: 'DEALING', 
      result: 'PENDING' 
    });

    currentRound = {
      _id: newDoc._id,
      roundId: newDoc.roundId,
      status: 'DEALING',
      result: 'PENDING',
      cards: null,
      handNames: null
    };

    // Phase 1: DEALING (3 seconds split card animation)
    phase = 'DEALING';
    roundTimer = 3;
    console.log(`[CASINO] Round ${roundId} - Phase: DEALING (3s)`);
    io.emit('casino_round_start', currentRound);
    broadcastState();

    timerInterval = setInterval(async () => {
      roundTimer--;
      broadcastState();

      if (roundTimer <= 0) {
        if (phase === 'DEALING') {
          // Transition to Phase 2: BETTING_OPEN (15 seconds)
          phase = 'OPEN';
          roundTimer = 15;
          currentRound.status = 'BETTING_OPEN';

          await CasinoRound.findByIdAndUpdate(currentRound._id, { status: 'BETTING_OPEN' });
          console.log(`[CASINO] Round ${roundId} - Phase: BETTING_OPEN (15s)`);
          broadcastState();

        } else if (phase === 'OPEN') {
          // Transition to Phase 3: BETTING_CLOSED (2 seconds)
          phase = 'CLOSED';
          roundTimer = 2;
          currentRound.status = 'BETTING_CLOSED';

          await CasinoRound.findByIdAndUpdate(currentRound._id, { status: 'BETTING_CLOSED' });
          console.log(`[CASINO] Round ${roundId} - Phase: BETTING_CLOSED (2s)`);
          io.emit('casino_betting_closed', currentRound);
          broadcastState();

        } else if (phase === 'CLOSED') {
          // Transition to Phase 4: RESULT_DECLARED & SHOW CARDS
          clearInterval(timerInterval);
          timerInterval = null;
          phase = 'RESULT';
          await declareResult();
        }
      }
    }, 1000);

  } catch (err) {
    console.error("[CASINO] Error starting new round", err);
    setTimeout(() => {
      isStartingRound = false;
      startNewRound();
    }, 5000);
  } finally {
    isStartingRound = false;
  }
}

async function declareResult() {
  if (!currentRound || isProcessingResult) {
    return;
  }
  isProcessingResult = true;

  try {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

    function drawCards(count = 3, existing = []) {
      const deck = [];
      for (const s of suits) {
        for (let i = 0; i < values.length; i++) {
          const card = { value: values[i], suit: s, rank: i };
          if (!existing.some(e => e.value === card.value && e.suit === card.suit)) {
            deck.push(card);
          }
        }
      }
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      return deck.slice(0, count);
    }

    let cardsA, cardsB, rankA, rankB;

    // Reroll if Tie for clean A vs B winner
    do {
      cardsA = drawCards(3);
      cardsB = drawCards(3, cardsA);
      rankA = getHandRank(cardsA);
      rankB = getHandRank(cardsB);
    } while (rankA.score === rankB.score);

    const winResult = rankA.score > rankB.score ? 'A' : 'B';

    currentRound.result = winResult;
    currentRound.cards = { A: cardsA, B: cardsB };
    currentRound.handNames = { A: rankA.type, B: rankB.type };
    currentRound.status = 'RESULT_DECLARED';
    roundTimer = 5;

    // Atomic DB update (prevents Mongoose ParallelSaveError completely)
    await CasinoRound.findByIdAndUpdate(currentRound._id, {
      $set: {
        result: winResult,
        cards: currentRound.cards,
        handNames: currentRound.handNames,
        status: 'RESULT_DECLARED'
      }
    });

    console.log(`[CASINO] Round ${currentRound.roundId} result is ${winResult} (${rankA.type} vs ${rankB.type})`);
    io.emit('casino_result_declared', currentRound);
    broadcastState();

    // Payout Settlement Logic
    const bets = await CasinoBet.find({ roundId: currentRound.roundId, status: 'PENDING' });

    if (bets.length > 0) {
      console.log(`[CASINO AUDIT] Round: ${currentRound.roundId} | Pending Bets: ${bets.length} | Winner: ${winResult}`);
      
      for (let bet of bets) {
        if (bet.choice === winResult) {
          bet.status = 'WIN';
          const profit = bet.amount * ((bet.odds || 2.0) - 1);
          const netProfit = profit * 0.95;
          const netPayout = bet.amount + netProfit;

          // Atomic wallet balance update
          const user = await User.findOneAndUpdate(
            { username: bet.userId },
            { $inc: { walletBalance: netPayout } },
            { new: true }
          );

          // House P&L hierarchy distribution
          await distributeCasinoPL(bet.userId, -netProfit, { matchName: currentRound.roundId, selection: bet.choice });

          if (user) {
            console.log(`[CASINO WINNER] User: ${bet.userId} | Choice: ${bet.choice} | Net Payout: $${netPayout.toFixed(2)}`);
            io.emit('wallet_updated', { userId: bet.userId, balance: user.walletBalance });
          }

          io.emit('casino_wallet_payout', { userId: bet.userId, amount: netPayout, choice: bet.choice, result: 'WIN' });
        } else {
          bet.status = 'LOSE';
          await distributeCasinoPL(bet.userId, bet.amount, { matchName: currentRound.roundId, selection: bet.choice });
          console.log(`[CASINO LOSER] User: ${bet.userId} | Choice: ${bet.choice} | Amount: $${bet.amount}`);
          io.emit('casino_wallet_payout', { userId: bet.userId, amount: bet.amount, choice: bet.choice, result: 'LOSE' });
        }
        await CasinoBet.findByIdAndUpdate(bet._id, { status: bet.status });
      }
    }

    // Schedule next round after 5 seconds show cards / suspense timeout
    setTimeout(() => {
      isProcessingResult = false;
      if (activePlayers.size > 0) {
        startNewRound();
      } else {
        console.log("[CASINO] All players left. Stopping session.");
        currentRound = null;
      }
    }, 5000);

  } catch (err) {
    console.error("[CASINO] Error declaring result", err);
    isProcessingResult = false;
  }
}

function getCurrentRound() { return currentRound; }

module.exports = { initRoundManager, getCurrentRound };
