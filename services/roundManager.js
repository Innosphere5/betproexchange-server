const CasinoRound = require('../models/CasinoRound');
const CasinoBet = require('../models/CasinoBet');
const User = require('../models/User');

let io = null;
let currentRound = null;
let roundTimer = 25;
let phase = 'INIT'; // INIT, OPEN, CLOSED
let timerInterval = null;
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
    console.log(`Socket connected: ${socket.id}`);

    // Send current state if available
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
      console.log(`Socket ${socket.id} joined casino. Active: ${activePlayers.size}`);

      // If this is the first player and no round is active, start one
      if (activePlayers.size === 1 && (!currentRound || currentRound.status === 'RESULT_DECLARED')) {
        console.log("First player joined, launching casino rounds...");
        startNewRound();
      }
    });

    socket.on('leave_casino', () => {
      activePlayers.delete(socket.id);
      console.log(`Socket ${socket.id} left casino. Active: ${activePlayers.size}`);
    });

    socket.on('disconnect', () => {
      activePlayers.delete(socket.id);
      console.log(`Socket ${socket.id} disconnected. Active: ${activePlayers.size}`);
    });
  });
}

async function startNewRound() {
  if (activePlayers.size === 0) {
    console.log("No active players. Casino idling...");
    currentRound = null;
    return;
  }
  try {
    const roundId = `RND-${Date.now()}`;
    currentRound = new CasinoRound({ roundId, status: 'BETTING_OPEN' });
    await currentRound.save();

    roundTimer = 20;
    phase = 'OPEN';
    console.log(`Starting Casino Round ${roundId} (Timer: 20s)`);

    io.emit('casino_round_start', currentRound);

    timerInterval = setInterval(async () => {
      roundTimer--;
      broadcastState();

      if (roundTimer <= 0 && phase === 'OPEN') {
        phase = 'CLOSED';
        currentRound.status = 'BETTING_CLOSED';
        await currentRound.save();
        io.emit('casino_betting_closed', currentRound);
        broadcastState();

        roundTimer = 5; // Suspense time
      } else if (roundTimer <= 0 && phase === 'CLOSED') {
        clearInterval(timerInterval);
        await declareResult();
      }
    }, 1000);
  } catch (err) {
    console.error("Error starting new round", err);
    setTimeout(startNewRound, 5000);
  }
}

function getHandRank(cards) {
  // Sort cards by rank descending
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map(c => c.rank);
  const suits = sorted.map(c => c.suit);

  const isTrail = ranks[0] === ranks[1] && ranks[1] === ranks[2];
  const isColor = suits[0] === suits[1] && suits[1] === suits[2];

  // Sequence check (A-2-3 is unique in Teen Patti, but we'll do standard for now)
  const isSequence = (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) ||
    (ranks[0] === 12 && ranks[1] === 1 && ranks[2] === 0); // A-2-3 (ranks 12, 0, 1) - slight fix needed

  const isPureSequence = isSequence && isColor;
  const isPair = ranks[0] === ranks[1] || ranks[1] === ranks[2] || ranks[0] === ranks[2];

  // Score calculation for comparison (RankType * base + TieBreakers)
  // 5: Trail, 4: Pure Seq, 3: Seq, 2: Color, 1: Pair, 0: High Card
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

const { distributeProfitLoss } = require('./hierarchyService');

async function declareResult() {
  if (!currentRound) {
    console.warn("[CASINO] Attempted to declare result but currentRound is null. Aborting.");
    return;
  }
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
      // Shuffle and pick
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      return deck.slice(0, count);
    }

    let cardsA, cardsB, rankA, rankB;

    // Reroll if Tie for clean A vs B win/loss
    do {
      cardsA = drawCards(3);
      cardsB = drawCards(3, cardsA);
      rankA = getHandRank(cardsA);
      rankB = getHandRank(cardsB);
    } while (rankA.score === rankB.score);

    const result = rankA.score > rankB.score ? 'A' : 'B';

    currentRound.result = result;
    currentRound.cards = { A: cardsA, B: cardsB };
    currentRound.handNames = { A: rankA.type, B: rankB.type };
    currentRound.status = 'RESULT_DECLARED';
    await currentRound.save();

    console.log(`Round ${currentRound.roundId} result is ${result} (${rankA.type} vs ${rankB.type})`);
    io.emit('casino_result_declared', currentRound);
    broadcastState();

    // Payout Logic
    const bets = await CasinoBet.find({ roundId: currentRound.roundId, status: 'PENDING' });

    if (bets.length > 0) {
      console.log(`[CASINO AUDIT] Round: ${currentRound.roundId} | Result: ${result}`);
      
      for (let bet of bets) {
        if (bet.choice === result) {
          bet.status = 'WIN';
          const profit = bet.amount * ((bet.odds || 2.0) - 1);
          const netProfit = profit * 0.95;
          const netPayout = bet.amount + netProfit;

          // Use ATOMIC update to credit wallet
          const user = await User.findOneAndUpdate(
            { username: bet.userId },
            { $inc: { walletBalance: netPayout } },
            { new: true }
          );

          // Distribute House Loss up the chain
          await distributeProfitLoss(bet.userId, -netProfit);

          if (user) {
            console.log(`[WINNER] User: ${bet.userId} | Choice: ${bet.choice} | Bet: ${bet.amount} | Payout: ${netPayout}`);
            io.emit('wallet_updated', { userId: bet.userId, balance: user.walletBalance });
          }

          io.emit('casino_wallet_payout', { userId: bet.userId, amount: netPayout, choice: bet.choice, result: 'WIN' });
        } else {
          bet.status = 'LOSE';
          
          // Distribute House Profit up the chain
          await distributeProfitLoss(bet.userId, bet.amount);

          console.log(`[LOSER] User: ${bet.userId} | Choice: ${bet.choice} | Bet: ${bet.amount} | Payout: 0`);
          io.emit('casino_wallet_payout', { userId: bet.userId, amount: bet.amount, choice: bet.choice, result: 'LOSE' });
        }
        await bet.save();
      }
    }

    setTimeout(() => {
      if (activePlayers.size > 0) {
        startNewRound();
      } else {
        console.log("All players left. Stopping session.");
        currentRound = null;
      }
    }, 4000);
  } catch (err) {
    console.error("Error generating result", err);
  }
}

function getCurrentRound() { return currentRound; }
module.exports = { initRoundManager, getCurrentRound };
