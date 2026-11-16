const mongoose = require('mongoose');
const CasinoRound = require('../models/CasinoRound');
const CasinoBet = require('../models/CasinoBet');
const User = require('../models/User');
const { distributeCasinoPL } = require('./hierarchyService');
const { validateBetLimit, capProfitByLimit } = require('./limitService');

let io = null;
let currentRound = null;
let roundTimer = 0;
let phase = 'INIT'; // INIT, IDLE, DEALING, OPEN, CLOSED, RESULT
let timerInterval = null;
let isProcessingResult = false;
let isStartingRound = false;

// In-memory active players tracking
const activePlayers = new Set();

// In-memory bets for the current round for zero-latency execution
let roundBets = [];

const TIMINGS = {
  DEALING_DURATION: 3,  // 3s dealing cards to A & B
  BETTING_DURATION: 8,  // 8s betting window (5-8s user requirement)
  REVEAL_DURATION: 4,   // 3.5-4s progressive card reveal suspense (3-4s user requirement)
  RESULT_DURATION: 4,   // 4s result display & celebration
  DEFAULT_ODDS: 1.98    // Standard 50/50 casino exchange odds
};

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function drawCards(count = 3, existing = []) {
  const deck = [];
  for (const s of SUITS) {
    for (let i = 0; i < VALUES.length; i++) {
      const card = { value: VALUES[i], suit: s, rank: i };
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

  io.emit('casino_state', {
    roundId: currentRound.roundId,
    status: currentRound.status,
    result: currentRound.status === 'RESULT_DECLARED' ? currentRound.result : 'PENDING',
    timer: roundTimer,
    cards: sanitizedCards,
    handNames: sanitizedHandNames,
    startTime: currentRound.startTime,
    endTime: currentRound.endTime,
    serverTimestamp: Date.now()
  });
}

function initRoundManager(socketIo) {
  io = socketIo;
  phase = 'IDLE';

  io.on('connection', (socket) => {
    const handlePlayerReady = () => {
      socket.join('casino');
      activePlayers.add(socket.id);

      if (phase === 'IDLE' || phase === 'INIT' || !timerInterval) {
        startNewRound();
      } else if (currentRound) {
        broadcastState();
      }
    };

    socket.on('join_casino', handlePlayerReady);
    socket.on('casino_ready', handlePlayerReady);

    const handlePlayerLeave = () => {
      socket.leave('casino');
      activePlayers.delete(socket.id);

      if (activePlayers.size === 0 && (phase === 'DEALING' || phase === 'OPEN')) {
        CasinoBet.countDocuments({ roundId: currentRound?.roundId, status: 'PENDING' })
          .then(count => {
            if (count === 0 && activePlayers.size === 0 && (phase === 'DEALING' || phase === 'OPEN')) {
              clearInterval(timerInterval);
              phase = 'IDLE';
              currentRound = null;
              broadcastState();
            }
          })
          .catch(() => {});
      }
    };

    socket.on('leave_casino', handlePlayerLeave);
    socket.on('disconnect', handlePlayerLeave);
  });
}

async function startNewRound() {
  if (isStartingRound) return;
  isStartingRound = true;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  try {
    const roundId = `RND-${Date.now()}`;
    roundBets = []; // Reset in-memory bets for new round

    // 1. Pre-deal cards with tie-break reroll so there's always a decisive winner
    let cardsA, cardsB, rankA, rankB;
    do {
      cardsA = drawCards(3);
      cardsB = drawCards(3, cardsA);
      rankA = getHandRank(cardsA);
      rankB = getHandRank(cardsB);
    } while (rankA.score === rankB.score);

    const winResult = rankA.score > rankB.score ? 'A' : 'B';

    const startTime = Date.now();
    const TOTAL_CYCLE = (TIMINGS.DEALING_DURATION + TIMINGS.BETTING_DURATION + TIMINGS.REVEAL_DURATION + TIMINGS.RESULT_DURATION) * 1000;
    const endTime = startTime + TOTAL_CYCLE;

    currentRound = {
      roundId,
      status: 'DEALING',
      startTime,
      endTime,
      result: 'PENDING',
      cards: { A: cardsA, B: cardsB },
      handNames: { A: rankA.type, B: rankB.type },
      winResult
    };

    // Save round in DB asynchronously
    CasinoRound.create({
      roundId,
      status: 'DEALING',
      result: 'PENDING',
      cards: currentRound.cards,
      handNames: currentRound.handNames
    }).then(doc => {
      if (currentRound && currentRound.roundId === roundId) {
        currentRound._id = doc._id;
      }
    }).catch(err => console.warn('[CASINO] DB create warning:', err.message));

    // Phase 1: DEALING (3 seconds card deal animation to A & B)
    phase = 'DEALING';
    roundTimer = TIMINGS.DEALING_DURATION;
    console.log(`[CASINO] Round ${roundId} - Phase 1: DEALING (${roundTimer}s)`);

    io.emit('casino_round_start', {
      roundId,
      status: 'DEALING',
      result: 'PENDING',
      cards: { A: [null, null, null], B: [null, null, null] },
      timer: roundTimer
    });
    broadcastState();

    timerInterval = setInterval(async () => {
      roundTimer--;
      broadcastState();

      if (roundTimer <= 0) {
        if (phase === 'DEALING') {
          // Phase 2: BETTING_OPEN (8 seconds user betting window)
          phase = 'OPEN';
          roundTimer = TIMINGS.BETTING_DURATION;
          currentRound.status = 'BETTING_OPEN';

          if (currentRound._id && mongoose.connection.readyState === 1) {
            CasinoRound.findByIdAndUpdate(currentRound._id, { status: 'BETTING_OPEN' }).catch(() => {});
          }
          console.log(`[CASINO] Round ${roundId} - Phase 2: BETTING_OPEN (${roundTimer}s)`);
          broadcastState();

        } else if (phase === 'OPEN') {
          // Phase 3: BETTING_CLOSED & REVEALING (4 seconds suspense card flips)
          phase = 'CLOSED';
          roundTimer = TIMINGS.REVEAL_DURATION;
          currentRound.status = 'BETTING_CLOSED';

          if (currentRound._id && mongoose.connection.readyState === 1) {
            CasinoRound.findByIdAndUpdate(currentRound._id, { status: 'BETTING_CLOSED' }).catch(() => {});
          }
          console.log(`[CASINO] Round ${roundId} - Phase 3: BETTING_CLOSED / REVEALING (${roundTimer}s)`);
          
          io.emit('casino_betting_closed', {
            roundId,
            status: 'BETTING_CLOSED',
            result: 'PENDING',
            cards: currentRound.cards,
            timer: roundTimer
          });
          broadcastState();

        } else if (phase === 'CLOSED') {
          // Phase 4: RESULT_DECLARED & PAYOUT
          clearInterval(timerInterval);
          timerInterval = null;
          phase = 'RESULT';
          await declareResult();
        }
      }
    }, 1000);
    if (timerInterval.unref) timerInterval.unref();

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
  if (!currentRound || isProcessingResult) return;
  isProcessingResult = true;

  try {
    const winResult = currentRound.winResult;
    currentRound.result = winResult;
    currentRound.status = 'RESULT_DECLARED';
    roundTimer = TIMINGS.RESULT_DURATION;

    if (currentRound._id && mongoose.connection.readyState === 1) {
      await CasinoRound.findByIdAndUpdate(currentRound._id, {
        $set: {
          result: winResult,
          cards: currentRound.cards,
          handNames: currentRound.handNames,
          status: 'RESULT_DECLARED'
        }
      }).catch(e => console.warn('[CASINO] Result save warning:', e.message));
    }

    console.log(`[CASINO] Round ${currentRound.roundId} result is ${winResult} (${currentRound.handNames?.A} vs ${currentRound.handNames?.B})`);
    io.emit('casino_result_declared', currentRound);
    broadcastState();

    // Settle all in-memory bets first
    const betsToSettle = [...roundBets];
    roundBets = [];

    // Also check DB for any pending bets from reconnected clients
    let allBets = betsToSettle;
    if (mongoose.connection.readyState === 1) {
      const dbBets = await CasinoBet.find({ roundId: currentRound.roundId, status: 'PENDING' });
      for (const dbBet of dbBets) {
        if (!allBets.some(b => String(b._id) === String(dbBet._id))) {
          allBets.push(dbBet);
        }
      }
    }

    for (let bet of allBets) {
      const isWin = bet.choice === winResult;
      const odds = bet.odds || TIMINGS.DEFAULT_ODDS;

      if (isWin) {
        bet.status = 'WIN';
        const grossProfit = bet.amount * (odds - 1);
        const rawNetProfit = grossProfit * 0.98; // 2% platform commission
        const { netProfit } = await capProfitByLimit(bet.userId, 'casino', rawNetProfit);
        const payout = bet.amount + netProfit;

        const user = await User.findOneAndUpdate(
          { username: bet.userId },
          { $inc: { walletBalance: payout } },
          { new: true }
        );

        distributeCasinoPL(bet.userId, -netProfit, {
          matchName: `Casino Round ${currentRound.roundId}`,
          selection: bet.choice
        }).catch(err => console.warn('[CASINO PL Win]', err.message));

        if (user) {
          io.emit('wallet_updated', { userId: bet.userId, balance: user.walletBalance });
        }

        io.emit('casino_wallet_payout', {
          userId: bet.userId,
          amount: payout,
          profit: netProfit,
          choice: bet.choice,
          result: 'WIN'
        });
      } else {
        bet.status = 'LOSE';
        distributeCasinoPL(bet.userId, bet.amount, {
          matchName: `Casino Round ${currentRound.roundId}`,
          selection: bet.choice
        }).catch(err => console.warn('[CASINO PL Lose]', err.message));

        io.emit('casino_wallet_payout', {
          userId: bet.userId,
          amount: bet.amount,
          choice: bet.choice,
          result: 'LOSE'
        });
      }

      CasinoBet.findByIdAndUpdate(bet._id, { status: bet.status }).catch(() => {});
    }

    // Schedule next round seamlessly after result display duration
    setTimeout(() => {
      isProcessingResult = false;
      if (activePlayers.size > 0) {
        startNewRound();
      } else {
        console.log('[CASINO] No active players. Pausing engine to IDLE.');
        phase = 'IDLE';
        currentRound = null;
        clearInterval(timerInterval);
        broadcastState();
      }
    }, TIMINGS.RESULT_DURATION * 1000);

  } catch (err) {
    console.error("[CASINO] Error declaring result", err);
    isProcessingResult = false;
  }
}

function drawDeterministicCasinoCards(roundId) {
  const fullDeck = [];
  for (const s of SUITS) {
    for (let i = 0; i < VALUES.length; i++) {
      fullDeck.push({ value: VALUES[i], suit: s, rank: i });
    }
  }

  const hash = crypto.createHmac('sha256', 'betpro-casino-provably-fair').update(roundId).digest('hex');
  const deck = [...fullDeck];
  for (let i = deck.length - 1; i > 0; i--) {
    const chunk = parseInt(hash.substring((i * 4) % (hash.length - 4), (i * 4) % (hash.length - 4) + 4), 16);
    const j = chunk % (i + 1);
    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
  }

  let cardsA = [deck[0], deck[1], deck[2]];
  let cardsB = [deck[3], deck[4], deck[5]];
  let rankA = getHandRank(cardsA);
  let rankB = getHandRank(cardsB);

  // If tie, break tie by replacing one card deterministically
  if (rankA.score === rankB.score) {
    cardsB = [deck[3], deck[4], deck[6]];
    rankB = getHandRank(cardsB);
  }

  return { cardsA, cardsB, rankA, rankB };
}

// ─── Deterministic Round Synchronization (Pure Vercel Serverless Resilient) ───────
function ensureLiveRound(now = Date.now()) {
  const TOTAL_CYCLE = (TIMINGS.DEALING_DURATION + TIMINGS.BETTING_DURATION + TIMINGS.REVEAL_DURATION + TIMINGS.RESULT_DURATION) * 1000; // 19000ms
  const cycleIndex = Math.floor(now / TOTAL_CYCLE);
  const startTime = cycleIndex * TOTAL_CYCLE;
  const endTime = startTime + TOTAL_CYCLE;
  const roundId = `RND-${startTime}`;

  const elapsed = now - startTime;
  const dealingEnd = TIMINGS.DEALING_DURATION * 1000; // 3000ms
  const bettingEnd = dealingEnd + (TIMINGS.BETTING_DURATION * 1000); // 11000ms
  const revealEnd = bettingEnd + (TIMINGS.REVEAL_DURATION * 1000); // 15000ms
  
  if (currentRound && currentRound.roundId === roundId) {
    if (elapsed < dealingEnd) {
      phase = 'DEALING';
      currentRound.status = 'DEALING';
      roundTimer = Math.ceil((bettingEnd - elapsed) / 1000);
    } else if (elapsed < bettingEnd) {
      phase = 'OPEN';
      currentRound.status = 'BETTING_OPEN';
      roundTimer = Math.ceil((bettingEnd - elapsed) / 1000);
    } else if (elapsed < revealEnd) {
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
        declareResult().catch(err => console.warn('[CASINO SETTLE]', err.message));
      }
    }
    return currentRound;
  }

  const { cardsA, cardsB, rankA, rankB } = drawDeterministicCasinoCards(roundId);
  const winResult = rankA.score > rankB.score ? 'A' : 'B';

  let currentPhase = 'OPEN';
  let currentStatus = 'BETTING_OPEN';
  let timer = 0;

  if (elapsed < dealingEnd) {
    currentPhase = 'DEALING';
    currentStatus = 'DEALING';
    timer = Math.ceil((bettingEnd - elapsed) / 1000);
  } else if (elapsed < bettingEnd) {
    currentPhase = 'OPEN';
    currentStatus = 'BETTING_OPEN';
    timer = Math.ceil((bettingEnd - elapsed) / 1000);
  } else if (elapsed < revealEnd) {
    currentPhase = 'CLOSED';
    currentStatus = 'BETTING_CLOSED';
    timer = 0;
  } else {
    currentPhase = 'RESULT';
    currentStatus = 'RESULT_DECLARED';
    timer = 0;
  }

  currentRound = {
    roundId,
    status: currentStatus,
    startTime,
    endTime,
    result: currentStatus === 'RESULT_DECLARED' ? winResult : 'PENDING',
    cards: { A: cardsA, B: cardsB },
    handNames: { A: rankA.type, B: rankB.type },
    winResult,
    settled: currentStatus === 'RESULT_DECLARED'
  };

  phase = currentPhase;
  roundTimer = timer;
  roundBets = [];

  if (mongoose.connection.readyState === 1) {
    CasinoRound.findOne({ roundId }).then(doc => {
      if (!doc) {
        CasinoRound.create({
          roundId,
          status: currentRound.status,
          result: currentRound.result,
          cards: currentRound.cards,
          handNames: currentRound.handNames
        }).catch(() => {});
      }
    }).catch(() => {});
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
    history: ['A', 'B', 'A', 'A', 'B', 'B', 'A'],
    serverTimestamp: now
  };
}

// In-Memory Zero-Latency Bet Engine
async function placeBet(userId, choice, amount) {
  const now = Date.now();
  const round = ensureLiveRound(now);

  if (round.status !== 'BETTING_OPEN' && round.status !== 'DEALING') {
    throw new Error('Betting is currently closed for this round');
  }

  if (choice !== 'A' && choice !== 'B') {
    throw new Error('Invalid choice. Must select Player A or Player B');
  }

  const stake = parseFloat(amount);
  if (!stake || isNaN(stake) || stake < 10) {
    throw new Error('Minimum bet amount is $10');
  }

  const odds = TIMINGS.DEFAULT_ODDS;
  const potentialProfit = stake * (odds - 1.0);
  await validateBetLimit(userId, 'casino', stake, potentialProfit);

  // Atomic balance deduction
  const user = await User.findOneAndUpdate(
    { username: userId, walletBalance: { $gte: stake } },
    { $inc: { walletBalance: -stake } },
    { new: true }
  );

  if (!user) {
    throw new Error('Insufficient wallet balance');
  }

  const bet = new CasinoBet({
    userId,
    roundId: round.roundId,
    choice,
    amount: stake,
    odds,
    status: 'PENDING'
  });

  // Save to DB asynchronously in background
  bet.save().catch(e => console.warn('[CASINO] DB save bet warning:', e.message));

  roundBets.push({
    _id: bet._id,
    userId,
    roundId: round.roundId,
    choice,
    amount: stake,
    odds,
    status: 'PENDING'
  });

  if (io) {
    io.emit('wallet_updated', { userId, balance: user.walletBalance });
    io.emit('casino_bet_placed', {
      userId,
      choice,
      amount: stake,
      odds,
      roundId: round.roundId
    });
  }

  return { success: true, balance: user.walletBalance, bet };
}

function getCurrentRound() {
  return currentRound || ensureLiveRound(Date.now());
}

module.exports = {
  initRoundManager,
  ensureLiveRound,
  getCurrentState,
  getCurrentRound,
  placeBet,
  getHandRank
};
