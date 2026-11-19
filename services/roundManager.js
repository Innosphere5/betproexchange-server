const crypto = require('crypto');
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

let gameTicker = null;

function broadcastState() {
  if (!io || !currentRound) return;
  const now = Date.now();
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

  io.emit('casino_state', {
    roundId: round.roundId,
    status: round.status,
    result: round.status === 'RESULT_DECLARED' ? round.result : 'PENDING',
    timer: roundTimer,
    cards: sanitizedCards,
    handNames: sanitizedHandNames,
    startTime: round.startTime,
    endTime: round.endTime,
    history: ['A', 'B', 'A', 'A', 'B', 'B', 'A'],
    serverTimestamp: now
  });
}

function initRoundManager(socketIo) {
  io = socketIo;
  if (gameTicker) {
    clearInterval(gameTicker);
    gameTicker = null;
  }
  console.log('[CASINO] Casino game engine is paused (under development).');
}

async function settleCasinoBets(round) {
  if (!round || isProcessingResult) return;
  isProcessingResult = true;

  try {
    const winResult = round.winResult;
    round.result = winResult;
    round.status = 'RESULT_DECLARED';

    if (mongoose.connection.readyState === 1) {
      await CasinoRound.findOneAndUpdate(
        { roundId: round.roundId },
        {
          $set: {
            result: winResult,
            cards: round.cards,
            handNames: round.handNames,
            status: 'RESULT_DECLARED'
          }
        }
      ).catch(() => {});
    }

    if (io) {
      io.emit('casino_result_declared', {
        roundId: round.roundId,
        status: 'RESULT_DECLARED',
        result: winResult,
        cards: round.cards,
        handNames: round.handNames
      });
    }

    const betsToSettle = [...roundBets];
    roundBets = [];

    if (mongoose.connection.readyState === 1) {
      const dbBets = await CasinoBet.find({ roundId: round.roundId, status: 'PENDING' });
      for (const dbBet of dbBets) {
        if (!betsToSettle.some(b => String(b._id) === String(dbBet._id))) {
          betsToSettle.push(dbBet);
        }
      }
    }

    for (let bet of betsToSettle) {
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
          matchName: `Casino Round ${round.roundId}`,
          selection: bet.choice
        }).catch(() => {});

        if (user && io) {
          io.emit('wallet_updated', { userId: bet.userId, balance: user.walletBalance });
        }

        if (io) {
          io.emit('casino_wallet_payout', {
            userId: bet.userId,
            amount: payout,
            profit: netProfit,
            choice: bet.choice,
            result: 'WIN'
          });
        }
      } else {
        bet.status = 'LOSE';
        distributeCasinoPL(bet.userId, bet.amount, {
          matchName: `Casino Round ${round.roundId}`,
          selection: bet.choice
        }).catch(() => {});

        if (io) {
          io.emit('casino_wallet_payout', {
            userId: bet.userId,
            amount: bet.amount,
            choice: bet.choice,
            result: 'LOSE'
          });
        }
      }

      if (mongoose.connection.readyState === 1 && bet._id) {
        CasinoBet.findByIdAndUpdate(bet._id, { status: bet.status }).catch(() => {});
      }
    }
  } finally {
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
  const TOTAL_CYCLE = 19000; // 19000ms: Dealing (3s) -> Betting (8s) -> Reveal (4s) -> Result (4s)
  const cycleIndex = Math.floor(now / TOTAL_CYCLE);
  const startTime = cycleIndex * TOTAL_CYCLE;
  const endTime = startTime + TOTAL_CYCLE;
  const roundId = `RND-${startTime}`;

  const elapsed = now - startTime;
  const dealingEnd = 3000;  // 0s to 3s: DEALING (3 seconds)
  const bettingEnd = 11000; // 3s to 11s: BETTING_OPEN (8 seconds)
  const revealEnd = 15000;  // 11s to 15s: BETTING_CLOSED & REVEALING (4 seconds)
  // 15s to 19s: RESULT_DECLARED (4 seconds)

  if (currentRound && currentRound.roundId === roundId) {
    if (elapsed < dealingEnd) {
      phase = 'DEALING';
      currentRound.status = 'DEALING';
      roundTimer = Math.ceil((dealingEnd - elapsed) / 1000); // 3, 2, 1s
    } else if (elapsed < bettingEnd) {
      phase = 'OPEN';
      currentRound.status = 'BETTING_OPEN';
      roundTimer = Math.ceil((bettingEnd - elapsed) / 1000); // 8, 7, 6, 5, 4, 3, 2, 1s
    } else if (elapsed < revealEnd) {
      phase = 'CLOSED';
      currentRound.status = 'BETTING_CLOSED';
      roundTimer = Math.ceil((revealEnd - elapsed) / 1000); // 4, 3, 2, 1s
    } else {
      phase = 'RESULT';
      currentRound.status = 'RESULT_DECLARED';
      currentRound.result = currentRound.winResult;
      roundTimer = Math.ceil((endTime - elapsed) / 1000); // 4, 3, 2, 1s
      if (!currentRound.settled) {
        currentRound.settled = true;
        settleCasinoBets(currentRound).catch(err => console.warn('[CASINO SETTLE]', err.message));
      }
    }
    return currentRound;
  }

  const { cardsA, cardsB, rankA, rankB } = drawDeterministicCasinoCards(roundId);
  const winResult = rankA.score > rankB.score ? 'A' : 'B';

  let currentPhase = 'DEALING';
  let currentStatus = 'DEALING';
  let timer = 3;

  if (elapsed < dealingEnd) {
    currentPhase = 'DEALING';
    currentStatus = 'DEALING';
    timer = Math.ceil((dealingEnd - elapsed) / 1000);
  } else if (elapsed < bettingEnd) {
    currentPhase = 'OPEN';
    currentStatus = 'BETTING_OPEN';
    timer = Math.ceil((bettingEnd - elapsed) / 1000);
  } else if (elapsed < revealEnd) {
    currentPhase = 'CLOSED';
    currentStatus = 'BETTING_CLOSED';
    timer = Math.ceil((revealEnd - elapsed) / 1000);
  } else {
    currentPhase = 'RESULT';
    currentStatus = 'RESULT_DECLARED';
    timer = Math.ceil((endTime - elapsed) / 1000);
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

  if (currentStatus === 'RESULT_DECLARED') {
    settleCasinoBets(currentRound).catch(err => console.warn('[CASINO SETTLE]', err.message));
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
