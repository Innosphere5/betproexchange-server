const crypto = require('crypto');
const User = require('../models/User');
const { isSuperAdminRole, SUPERADMIN_DISPLAY_BALANCE } = require('../utils/superAdminWallet');

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const HAND_SCORE_BASE = {
  HIGH_CARD: 0,
  PAIR: 20000,
  COLOR: 30000,
  SEQUENCE: 40000,
  PURE_SEQUENCE: 50000,
  TRAIL: 60000,
};

const PAIR_PLUS_MULTIPLIERS = {
  'TRAIL': 46.0,
  'PURE SEQUENCE': 36.0,
  'SEQUENCE': 7.0,
  'COLOR': 5.0,
  'PAIR': 2.0,
};

function round2(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let i = 0; i < VALUES.length; i++) {
      deck.push({ value: VALUES[i], suit, rank: i });
    }
  }
  return deck;
}

function cryptoShuffle(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Evaluates a 3-card Teen Patti hand.
 * Order (highest -> lowest): TRAIL > PURE SEQUENCE > SEQUENCE > COLOR > PAIR > HIGH CARD.
 * Within sequences: Q-K-A (12) highest down to 2-3-4 (2), and A-2-3 (1) lowest per standard rules.
 */
function getHandRank(cards) {
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  const ranks = sorted.map((c) => c.rank);
  const suits = sorted.map((c) => c.suit);

  const isTrail = ranks[0] === ranks[1] && ranks[1] === ranks[2];
  const isColor = suits[0] === suits[1] && suits[1] === suits[2];

  let isSequence = false;
  let seqHigh = ranks[0];
  if (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) {
    isSequence = true;
    seqHigh = ranks[0];
  } else if (ranks[0] === 12 && ranks[1] === 1 && ranks[2] === 0) {
    // A-2-3 is the lowest valid sequence (below 4-3-2 which has seqHigh = 2)
    isSequence = true;
    seqHigh = 1;
  }

  const isPureSequence = isSequence && isColor;

  if (isTrail) {
    return { type: 'TRAIL', score: HAND_SCORE_BASE.TRAIL + ranks[0] };
  }
  if (isPureSequence) {
    return { type: 'PURE SEQUENCE', score: HAND_SCORE_BASE.PURE_SEQUENCE + seqHigh };
  }
  if (isSequence) {
    return { type: 'SEQUENCE', score: HAND_SCORE_BASE.SEQUENCE + seqHigh };
  }
  if (isColor) {
    return {
      type: 'COLOR',
      score: HAND_SCORE_BASE.COLOR + ranks[0] * 256 + ranks[1] * 16 + ranks[2],
    };
  }

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

  if (pairRank >= 0) {
    return {
      type: 'PAIR',
      score: HAND_SCORE_BASE.PAIR + pairRank * 16 + kicker,
    };
  }

  return {
    type: 'HIGH CARD',
    score: HAND_SCORE_BASE.HIGH_CARD + ranks[0] * 256 + ranks[1] * 16 + ranks[2],
  };
}

/**
 * Draws guaranteed non-tying Player A and Player B 3-card hands
 * with a provably fair SHA-256 seed commitment.
 */
function dealProvablyFairHands(roundId) {
  const serverSeed = crypto.randomBytes(16).toString('hex');
  const seedHash = crypto
    .createHash('sha256')
    .update(`${roundId}:${serverSeed}`)
    .digest('hex');

  let cardsA;
  let cardsB;
  let rankA;
  let rankB;

  for (let attempt = 0; attempt < 15; attempt++) {
    const shuffled = cryptoShuffle(createDeck());
    cardsA = shuffled.slice(0, 3);
    cardsB = shuffled.slice(3, 6);
    rankA = getHandRank(cardsA);
    rankB = getHandRank(cardsB);
    if (rankA.score !== rankB.score) break;
  }

  return {
    cardsA,
    cardsB,
    rankA,
    rankB,
    winResult: rankA.score > rankB.score ? 'A' : 'B',
    serverSeed,
    seedHash,
  };
}

function getRedisCacheSafe() {
  try {
    return require('./upstashRedisCache');
  } catch {
    return null;
  }
}

function emitWalletUpdate(io, username, balance, credit = 0) {
  if (!io || !username) return;
  const payload = { userId: username, balance, credit };
  const exactRoom = `user:${username}`;
  const lowerRoom = `user:${String(username).toLowerCase()}`;
  io.to(exactRoom).emit('wallet_updated', payload);
  if (lowerRoom !== exactRoom) {
    io.to(lowerRoom).emit('wallet_updated', payload);
  }
}

/**
 * Atomically debits `debitAmount` from a player's wallet (honoring SuperAdmin unlimited spend)
 * and updates Upstash Redis wallet cache + targeted Socket room.
 */
async function debitPlayerWallet(username, debitAmount, io = null) {
  const existingUser = await User.findOne({ username }).select('username role walletBalance credit').lean();
  if (!existingUser) {
    throw new Error('User account not found');
  }

  if (isSuperAdminRole(existingUser)) {
    emitWalletUpdate(io, username, SUPERADMIN_DISPLAY_BALANCE, 0);
    return {
      username: existingUser.username,
      role: existingUser.role,
      effectiveBalance: SUPERADMIN_DISPLAY_BALANCE,
      credit: 0,
      isSuperAdmin: true,
    };
  }

  const updated = await User.findOneAndUpdate(
    { username, walletBalance: { $gte: debitAmount } },
    { $inc: { walletBalance: -debitAmount } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    throw new Error('Insufficient wallet balance');
  }

  const redisCache = getRedisCacheSafe();
  if (redisCache) {
    redisCache.setUserWallet(username, {
      balance: updated.walletBalance,
      credit: updated.credit || 0,
    }, 15000).catch(() => {});
  }

  emitWalletUpdate(io, username, updated.walletBalance, updated.credit || 0);

  return {
    username: updated.username,
    role: updated.role,
    effectiveBalance: updated.walletBalance,
    credit: updated.credit || 0,
    isSuperAdmin: false,
  };
}

/**
 * Atomically credits payout back to a winning player (keeping SuperAdmin fixed at display balance).
 */
async function creditPlayerWallet(username, creditAmount, io = null) {
  const existingUser = await User.findOne({ username }).select('username role walletBalance credit').lean();
  if (!existingUser) return null;

  if (isSuperAdminRole(existingUser)) {
    emitWalletUpdate(io, username, SUPERADMIN_DISPLAY_BALANCE, 0);
    return {
      effectiveBalance: SUPERADMIN_DISPLAY_BALANCE,
      credit: 0,
      isSuperAdmin: true,
    };
  }

  const updated = await User.findOneAndUpdate(
    { username },
    { $inc: { walletBalance: creditAmount } },
    { returnDocument: 'after' }
  );

  if (!updated) return null;

  const redisCache = getRedisCacheSafe();
  if (redisCache) {
    redisCache.setUserWallet(username, {
      balance: updated.walletBalance,
      credit: updated.credit || 0,
    }, 15000).catch(() => {});
  }

  emitWalletUpdate(io, username, updated.walletBalance, updated.credit || 0);

  return {
    effectiveBalance: updated.walletBalance,
    credit: updated.credit || 0,
    isSuperAdmin: false,
  };
}

module.exports = {
  SUITS,
  VALUES,
  PAIR_PLUS_MULTIPLIERS,
  round2,
  createDeck,
  cryptoShuffle,
  getHandRank,
  dealProvablyFairHands,
  debitPlayerWallet,
  creditPlayerWallet,
  emitWalletUpdate,
};
