const crypto = require('crypto');
const mongoose = require('mongoose');
const AviatorRound = require('../models/AviatorRound');
const AviatorBet = require('../models/AviatorBet');
const User = require('../models/User');
const { distributeCasinoPL } = require('./hierarchyService');
const { validateBetLimit, capProfitByLimit } = require('./limitService');

let io = null;
let currentRound = null;
let roundTimer = 0;
let phase = 'INIT'; // INIT, BETTING, FLYING, CRASHED
let timerInterval = null;
let tickInterval = null;
let takeoffTime = null;
let crashTime = null;
let history = [];
const activePlayers = new Set();

// Bot player list to simulate multiplayer traffic
const BOT_NAMES = [
  'JackpotKing', 'LuckyStriker', 'AeroGamer', 'NovaCrash', 'Spitfire', 
  'HyperDrive', 'AlphaJet', 'LunaCrasher', 'RiskTaker', 'GoldDigger', 
  'Zenith', 'CryptoRocket', 'BlitzBets', 'Nebula', 'MaxProfit'
];

let virtualBets = []; // Holds fake bots active in the current round
let roundBets = [];   // In-memory pending bets for real players in the current round

const BETTING_DURATION = 6000; // 6 seconds betting window
const CRASHED_DURATION = 3000; // 3 seconds show crash window

// 1.07^t growth curve for Aviator (old JetRun)
function getMultiplierAt(elapsedMs) {
  const seconds = elapsedMs / 1000;
  return parseFloat(Math.pow(1.07, seconds).toFixed(2));
}

// Calculate the precise ms at which a multiplier crashes
function getMsForMultiplier(multiplier) {
  if (multiplier <= 1.00) return 0;
  return (Math.log(multiplier) / Math.log(1.07)) * 1000;
}

// Provably Fair Crash Point Generation
function generateProvablyFairRound(nonce) {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const clientSeed = 'jetrun-game-salt'; // Custom salt for Aviator (old JetRun)
  
  const hash = crypto.createHmac('sha256', serverSeed)
                     .update(`${clientSeed}-${nonce}`)
                     .digest('hex');
  
  const h = parseInt(hash.substring(0, 13), 16);
  const e = Math.pow(2, 52);
  
  let crashPoint;
  // 3.5% house edge: 3.5% of rounds crash instantly at 1.00
  if (h % 28 === 0) {
    crashPoint = 1.00;
  } else {
    crashPoint = Math.floor((100 * e - h) / (e - h)) / 100;
  }
  
  crashPoint = Math.max(1.00, parseFloat(crashPoint.toFixed(2)));
  
  // Cap extreme multipliers at 10000x for liability limits
  if (crashPoint > 10000) {
    crashPoint = 10000;
  }
  
  return {
    serverSeed,
    serverSeedHash,
    clientSeed,
    crashPoint
  };
}

async function loadHistory() {
  try {
    const pastRounds = await AviatorRound.find({ status: 'CRASHED' })
                                         .sort({ endTime: -1 })
                                         .limit(20);
    if (pastRounds && pastRounds.length > 0) {
      history = pastRounds.map(r => r.crashPoint).reverse();
    } else if (history.length === 0) {
      history = [1.85, 2.14, 1.25, 4.50, 1.12, 3.20, 1.68, 5.40, 2.05, 1.35];
    }
  } catch (err) {
    console.warn('[AVIATOR] Error loading history (using fallback):', err.message);
    if (history.length === 0) {
      history = [1.85, 2.14, 1.25, 4.50, 1.12, 3.20, 1.68, 5.40, 2.05, 1.35];
    }
  }
}

function broadcastState() {
  if (!io) return;
  
  const now = Date.now();
  let elapsedMs = 0;
  let multiplier = 1.00;
  
  if (phase === 'FLYING' && takeoffTime) {
    elapsedMs = now - takeoffTime;
    multiplier = getMultiplierAt(elapsedMs);
  }
  
  io.to('aviator').emit('aviator_state', {
    roundId: currentRound ? currentRound.roundId : '',
    phase,
    elapsedMs,
    multiplier,
    timer: roundTimer,
    startTime: currentRound ? currentRound.startTime : null,
    takeoffTime: currentRound ? currentRound.takeoffTime : takeoffTime,
    crashTime: currentRound ? currentRound.crashTime : crashTime,
    endTime: currentRound ? currentRound.endTime : null,
    crashPoint: (currentRound && phase === 'CRASHED') ? currentRound.crashPoint : null,
    serverSeedHash: currentRound ? currentRound.serverSeedHash : '',
    serverSeed: (currentRound && phase === 'CRASHED') ? currentRound.serverSeed : null,
    history,
    bots: virtualBets.map(b => ({
      userId: b.userId,
      stake: b.stake,
      autoCashoutMultiplier: b.autoCashoutMultiplier,
      cashed: Boolean(b.cashed),
      multiplier: b.cashed ? b.autoCashoutMultiplier : null,
      payout: b.cashed ? Math.round(b.stake * b.autoCashoutMultiplier) : 0
    })),
    serverTimestamp: now
  });
}

function initAviatorManager(socketIo) {
  io = socketIo;
  loadHistory();

  // On boot, start in IDLE state. Engine runs ONLY when players are present and ready!
  phase = 'IDLE';

  io.on('connection', (socket) => {
    const handlePlayerReady = () => {
      socket.join('aviator');
      activePlayers.add(socket.id);
      console.log(`[AVIATOR] Socket ${socket.id} joined/ready. Active players: ${activePlayers.size}`);

      // If game is IDLE, start betting phase immediately so the player can play!
      if (phase === 'IDLE' || phase === 'INIT' || (!timerInterval && !tickInterval)) {
        startBettingPhase();
      } else {
        // Send immediate sync of ongoing round
        const now = Date.now();
        let elapsedMs = 0;
        let multiplier = 1.00;
        if (phase === 'FLYING' && takeoffTime) {
          elapsedMs = now - takeoffTime;
          multiplier = getMultiplierAt(elapsedMs);
        }
        socket.emit('aviator_state', {
          roundId: currentRound ? currentRound.roundId : '',
          phase,
          elapsedMs,
          multiplier,
          timer: roundTimer,
          serverSeedHash: currentRound ? currentRound.serverSeedHash : '',
          serverSeed: (currentRound && phase === 'CRASHED') ? currentRound.serverSeed : null,
          crashPoint: (currentRound && phase === 'CRASHED') ? currentRound.crashPoint : null,
          history,
          serverTimestamp: now
        });
      }
    };

    socket.on('join_aviator', handlePlayerReady);
    socket.on('aviator_ready', handlePlayerReady);

    const handlePlayerLeave = () => {
      socket.leave('aviator');
      activePlayers.delete(socket.id);
      console.log(`[AVIATOR] Socket ${socket.id} left. Active players: ${activePlayers.size}`);

      // If no players remain in room and game is currently in BETTING phase with no bets placed, pause immediately to IDLE
      if (activePlayers.size === 0 && phase === 'BETTING') {
        AviatorBet.countDocuments({ roundId: currentRound?.roundId, status: 'PENDING' })
          .then(count => {
            if (count === 0 && activePlayers.size === 0 && phase === 'BETTING') {
              console.log('[AVIATOR] All players left with no bets. Entering IDLE state.');
              clearInterval(timerInterval);
              phase = 'IDLE';
              currentRound = null;
              broadcastState();
            }
          })
          .catch(() => {});
      }
    };

    socket.on('leave_aviator', handlePlayerLeave);
    socket.on('disconnect', handlePlayerLeave);
  });
}

async function startBettingPhase() {
  try {
    if (tickInterval) clearInterval(tickInterval);
    if (timerInterval) clearInterval(timerInterval);
    tickInterval = null;
    timerInterval = null;

    phase = 'BETTING';
    roundTimer = BETTING_DURATION;
    virtualBets = []; // Reset bots for new round
    roundBets = [];   // Reset in-memory real player bets for new round
    
    const nonce = Date.now();
    const fairData = generateProvablyFairRound(nonce);
    const startTime = Date.now();
    const roundId = `AV-${startTime}`;
    const takeoff = startTime + BETTING_DURATION;
    const flightDuration = getMsForMultiplier(fairData.crashPoint);
    const crash = takeoff + flightDuration;
    const end = crash + CRASHED_DURATION;

    takeoffTime = takeoff;
    crashTime = crash;

    currentRound = {
      roundId,
      status: 'BETTING_OPEN',
      startTime,
      takeoffTime: takeoff,
      crashTime: crash,
      endTime: end,
      flightDuration,
      serverSeed: fairData.serverSeed,
      serverSeedHash: fairData.serverSeedHash,
      clientSeed: fairData.clientSeed,
      nonce,
      crashPoint: fairData.crashPoint
    };

    if (mongoose.connection.readyState === 1) {
      const roundDoc = new AviatorRound({
        roundId,
        status: 'BETTING_OPEN',
        startTime: new Date(startTime),
        serverSeed: fairData.serverSeed,
        serverSeedHash: fairData.serverSeedHash,
        clientSeed: fairData.clientSeed,
        nonce,
        crashPoint: fairData.crashPoint
      });
      roundDoc.save().catch(err => console.warn('[AVIATOR] DB save warning:', err.message));
    }
    console.log(`[AVIATOR] New round: ${roundId} | CrashPoint: ${fairData.crashPoint}`);

    // Immediately broadcast BETTING countdown state to room
    broadcastState();

    // Generate random bots placing bets
    const botCount = Math.floor(Math.random() * 8) + 4; // 4 to 12 bots
    for (let i = 0; i < botCount; i++) {
      const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(Math.random() * 900 + 100);
      const stake = Math.floor(Math.random() * 1500) + 100;
      const targetCashout = parseFloat((Math.random() * 4 + 1.2).toFixed(2));
      
      virtualBets.push({
        userId: name,
        stake,
        autoCashoutMultiplier: targetCashout,
        cashed: false
      });
    }

    const startTimestamp = Date.now();
    let botBetTriggerTime = 800; // Trigger bot bet sockets sequentially

    timerInterval = setInterval(() => {
      const elapsed = Date.now() - startTimestamp;
      roundTimer = Math.max(0, BETTING_DURATION - elapsed);
      broadcastState();
      
      // Simulate bots placing bets periodically during countdown
      if (elapsed > botBetTriggerTime && virtualBets.length > 0) {
        const nextBotIndex = virtualBets.findIndex(b => !b.activeEmit);
        if (nextBotIndex !== -1) {
          virtualBets[nextBotIndex].activeEmit = true;
          io.to('aviator').emit('aviator_bet_placed', {
            userId: virtualBets[nextBotIndex].userId,
            betSlot: 1,
            stake: virtualBets[nextBotIndex].stake,
            autoCashoutMultiplier: virtualBets[nextBotIndex].autoCashoutMultiplier
          });
        }
        botBetTriggerTime += Math.floor(Math.random() * 800) + 400;
      }

      if (roundTimer <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        startFlyingPhase();
      }
    }, 100);
    if (timerInterval.unref) timerInterval.unref();
  } catch (err) {
    console.error('[AVIATOR] Error initializing betting phase:', err);
    setTimeout(startBettingPhase, 5000);
  }
}

async function startFlyingPhase() {
  try {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    phase = 'FLYING';
    takeoffTime = Date.now();
    
    if (currentRound) {
      currentRound.status = 'FLYING';
      if (typeof currentRound.save === 'function') {
        currentRound.save().catch(err => console.warn('[AVIATOR] Save flying status warning:', err.message));
      }
    }
    
    const crashPoint = currentRound ? currentRound.crashPoint : 1.5;
    const flightDuration = getMsForMultiplier(crashPoint);
    crashTime = takeoffTime + flightDuration;
    console.log(`[AVIATOR] Plane taking off. Crashes in ${flightDuration.toFixed(0)}ms at ${crashPoint}x`);

    // Broadcast FLYING state immediately on liftoff
    broadcastState();

    // Fallback sync: if in-memory roundBets is empty, load active bets once
    if (roundBets.length === 0 && currentRound && mongoose.connection.readyState === 1) {
      AviatorBet.find({ roundId: currentRound.roundId, status: 'PENDING' })
        .lean()
        .then(bets => {
          if (bets && bets.length > 0) {
            bets.forEach(b => {
              if (!roundBets.some(rb => rb._id.toString() === b._id.toString())) {
                roundBets.push({
                  _id: b._id,
                  userId: b.userId,
                  betSlot: b.betSlot,
                  stake: b.stake,
                  autoCashoutMultiplier: b.autoCashoutMultiplier,
                  status: 'PENDING',
                  cashed: false
                });
              }
            });
          }
        })
        .catch(() => {});
    }

    tickInterval = setInterval(() => {
      const now = Date.now();
      
      if (now >= crashTime) {
        clearInterval(tickInterval);
        tickInterval = null;
        triggerCrash();
      } else {
        const elapsedMs = now - takeoffTime;
        const currentMultiplier = getMultiplierAt(elapsedMs);
        
        // High performance in-memory check for player auto-cashouts (ZERO DB queries per tick!)
        for (const bet of roundBets) {
          if (!bet.cashed && bet.status === 'PENDING' && bet.autoCashoutMultiplier && currentMultiplier >= bet.autoCashoutMultiplier && bet.autoCashoutMultiplier < crashPoint) {
            bet.cashed = true;
            bet.status = 'WON';
            processAutoCashout(bet, bet.autoCashoutMultiplier);
          }
        }

        // Evaluate and simulate cashouts for bots
        virtualBets.forEach(bot => {
          if (!bot.cashed && currentMultiplier >= bot.autoCashoutMultiplier && bot.autoCashoutMultiplier < crashPoint) {
            bot.cashed = true;
            const payout = Math.round(bot.stake * bot.autoCashoutMultiplier);
            io.to('aviator').emit('aviator_cashout_success', {
              userId: bot.userId,
              betSlot: 1,
              multiplier: bot.autoCashoutMultiplier,
              payout
            });
          }
        });

        broadcastState();
      }
    }, 50);
    if (tickInterval.unref) tickInterval.unref();
  } catch (err) {
    console.error('[AVIATOR] Error starting flying phase:', err);
    startBettingPhase();
  }
}

async function processAutoCashout(bet, actualMultiplier) {
  try {
    const grossPayout = Math.round(bet.stake * actualMultiplier * 100) / 100;
    const rawNetProfit = Math.round((grossPayout - bet.stake) * 0.98 * 100) / 100; // 2% house commission
    const { netProfit } = await capProfitByLimit(bet.userId, 'aviator', rawNetProfit);
    const netPayout = bet.stake + netProfit;

    const updatedBet = await AviatorBet.findOneAndUpdate(
      { _id: bet._id, status: 'PENDING' },
      {
        status: 'WON',
        cashoutMultiplier: actualMultiplier,
        cashoutTime: new Date(),
        payout: netPayout
      },
      { new: true }
    );

    if (updatedBet) {
      const user = await User.findOneAndUpdate(
        { username: bet.userId },
        { $inc: { walletBalance: netPayout } },
        { new: true }
      );

      if (user) {
        await distributeCasinoPL(bet.userId, -netProfit, {
          matchName: `Aviator Round ${currentRound ? currentRound.roundId : ''}`,
          selection: `Won @ Auto-Cashout ${actualMultiplier}x`
        });

        io.emit('wallet_updated', { userId: bet.userId, balance: user.walletBalance });
        io.to('aviator').emit('aviator_cashout_success', {
          userId: bet.userId,
          betSlot: bet.betSlot,
          multiplier: actualMultiplier,
          payout: netPayout
        });
        console.log(`[AVIATOR] Auto-Cashout successful for ${bet.userId} at ${actualMultiplier}x`);
      }
    }
  } catch (err) {
    console.error('[AVIATOR] Error processing auto-cashout:', err);
  }
}

async function triggerCrash() {
  try {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    phase = 'CRASHED';
    const finalMultiplier = currentRound ? currentRound.crashPoint : 1.00;
    if (currentRound) {
      currentRound.status = 'CRASHED';
      currentRound.endTime = new Date();
      if (typeof currentRound.save === 'function') {
        currentRound.save().catch(err => console.warn('[AVIATOR] Save crash status warning:', err.message));
      }
      console.log(`[AVIATOR] Plane crashed at ${finalMultiplier}x. Reveal Seed: ${currentRound.serverSeed}`);
    }
    
    history.push(finalMultiplier);
    if (history.length > 30) history.shift();

    // Mark remaining in-memory bets as LOST
    roundBets.forEach(b => {
      if (b.status === 'PENDING') {
        b.status = 'LOST';
      }
    });

    // Settle all remaining pending bets in this round in DB
    if (currentRound && mongoose.connection.readyState === 1) {
      const uncashedBets = await AviatorBet.find({
        roundId: currentRound.roundId,
        status: 'PENDING'
      });

      for (const bet of uncashedBets) {
        bet.status = 'LOST';
        await bet.save();

        await distributeCasinoPL(bet.userId, bet.stake, {
          matchName: `Aviator Round ${currentRound.roundId}`,
          selection: `Lost @ Crash ${finalMultiplier}x`
        });
        
        console.log(`[AVIATOR] Settle lost bet for user ${bet.userId} | Stake: ${bet.stake}`);
      }
    }

    broadcastState();

    // Autonomous loop only continues if players are active in the room!
    setTimeout(() => {
      if (activePlayers.size > 0) {
        startBettingPhase();
      } else {
        console.log('[AVIATOR] No active players in room. Entering IDLE phase.');
        phase = 'IDLE';
        currentRound = null;
        if (timerInterval) clearInterval(timerInterval);
        if (tickInterval) clearInterval(tickInterval);
        timerInterval = null;
        tickInterval = null;
        broadcastState();
      }
    }, CRASHED_DURATION);
  } catch (err) {
    console.error('[AVIATOR] Error triggering crash:', err);
    if (activePlayers.size > 0) {
      setTimeout(startBettingPhase, 5000);
    } else {
      phase = 'IDLE';
      currentRound = null;
      broadcastState();
    }
  }
}

// Service helper called by Express APIs
async function placeBet(userId, betSlot, stake, autoCashoutMultiplier) {
  const now = Date.now();
  const round = ensureLiveRound(now);

  if (now >= round.takeoffTime) {
    throw new Error('Betting is closed for this round');
  }
  
  if (!stake || isNaN(stake) || stake < 10) {
    throw new Error('Invalid stake amount (minimum 10)');
  }

  // Validate hierarchical max bet size & profit limit for Aviator
  const estimatedProfit = autoCashoutMultiplier ? Math.round(stake * (parseFloat(autoCashoutMultiplier) - 1)) : 0;
  await validateBetLimit(userId, 'aviator', stake, estimatedProfit);

  // Fast in-memory double-bet validation
  const memExisting = roundBets.find(b => b.userId === userId && b.betSlot === betSlot && b.roundId === round.roundId);
  if (memExisting) {
    throw new Error(`Bet already placed on Slot ${betSlot}`);
  }

  // Deduct balance atomically
  const user = await User.findOneAndUpdate(
    { username: userId, walletBalance: { $gte: stake } },
    { $inc: { walletBalance: -stake } },
    { new: true }
  );

  if (!user) {
    throw new Error('Insufficient wallet balance');
  }

  const bet = new AviatorBet({
    userId,
    roundId: round.roundId,
    betSlot,
    stake,
    autoCashoutMultiplier: autoCashoutMultiplier ? parseFloat(autoCashoutMultiplier) : null,
    status: 'PENDING'
  });

  // Save bet to database asynchronously in background without blocking response
  bet.save().catch(err => console.warn('[AVIATOR] Bet save warning:', err.message));

  roundBets.push({
    _id: bet._id,
    userId,
    roundId: round.roundId,
    betSlot,
    stake,
    autoCashoutMultiplier: autoCashoutMultiplier ? parseFloat(autoCashoutMultiplier) : null,
    status: 'PENDING',
    cashed: false
  });

  if (io) {
    io.emit('wallet_updated', { userId, balance: user.walletBalance });
    io.to('aviator').emit('aviator_bet_placed', {
      userId,
      betSlot,
      stake,
      autoCashoutMultiplier
    });
  }

  return { success: true, balance: user.walletBalance, bet };
}

async function cashout(userId, betSlot) {
  const now = Date.now();
  const round = ensureLiveRound(now);

  if (now < round.takeoffTime) {
    throw new Error('Game is not currently flying');
  }

  if (now >= round.crashTime) {
    throw new Error('Game has already crashed');
  }

  const elapsedMs = now - round.takeoffTime;
  const currentMultiplier = Math.min(round.crashPoint, getMultiplierAt(elapsedMs));

  // Fast in-memory resolution first for zero-latency crash game performance
  let memBet = roundBets.find(b => b.userId === userId && b.betSlot === betSlot && b.roundId === round.roundId);
  if (memBet && (memBet.cashed || memBet.status === 'WON')) {
    return {
      success: true,
      alreadyWon: true,
      multiplier: memBet.cashoutMultiplier,
      payout: memBet.payout
    };
  }

  let betId = memBet ? memBet._id : null;
  let stake = memBet ? memBet.stake : null;

  if (!memBet) {
    // Fallback: check DB if not found in memory (e.g. server restart)
    let bet = await AviatorBet.findOne({
      userId,
      roundId: round.roundId,
      betSlot,
      status: 'PENDING'
    });

    if (!bet) {
      const wonBet = await AviatorBet.findOne({
        userId,
        roundId: round.roundId,
        betSlot,
        status: 'WON'
      });
      if (wonBet) {
        const u = await User.findOne({ username: userId });
        return {
          success: true,
          alreadyWon: true,
          balance: u ? u.walletBalance : 0,
          bet: wonBet,
          multiplier: wonBet.cashoutMultiplier,
          payout: wonBet.payout
        };
      }

      const lostBet = await AviatorBet.findOne({
        userId,
        roundId: round.roundId,
        betSlot,
        status: 'LOST'
      });
      if (lostBet) {
        throw new Error('Round already ended or bet lost');
      }

      throw new Error('Active bet not found');
    }

    betId = bet._id;
    stake = bet.stake;
  }

  // Calculate payouts
  const grossPayout = Math.round(stake * currentMultiplier * 100) / 100;
  const rawNetProfit = Math.round((grossPayout - stake) * 0.98 * 100) / 100; // 2% house commission
  const { netProfit } = await capProfitByLimit(userId, 'aviator', rawNetProfit);
  const netPayout = stake + netProfit;

  // Immediate in-memory lock to guarantee single settlement
  if (memBet) {
    memBet.cashed = true;
    memBet.status = 'WON';
    memBet.cashoutMultiplier = currentMultiplier;
    memBet.payout = netPayout;
  }

  // Real-time broadcast to room immediately
  io.to('aviator').emit('aviator_cashout_success', {
    userId,
    betSlot,
    multiplier: currentMultiplier,
    payout: netPayout
  });

  // Concurrent atomic database updates (wallet balance + bet status)
  const [user, updatedBet] = await Promise.all([
    User.findOneAndUpdate(
      { username: userId },
      { $inc: { walletBalance: netPayout } },
      { new: true }
    ),
    AviatorBet.findOneAndUpdate(
      { _id: betId, status: 'PENDING' },
      {
        status: 'WON',
        cashoutMultiplier: currentMultiplier,
        cashoutTime: new Date(now),
        payout: netPayout
      },
      { new: true }
    )
  ]);

  if (user) {
    io.emit('wallet_updated', { userId, balance: user.walletBalance });
  }

  // Asynchronous profit/loss hierarchy distribution without blocking the response
  distributeCasinoPL(userId, -netProfit, {
    matchName: `Aviator Round ${currentRound.roundId}`,
    selection: `Won @ Cashout ${currentMultiplier}x`
  }).catch(err => console.error('[Aviator distributeCasinoPL]', err));

  return {
    success: true,
    balance: user ? user.walletBalance : 0,
    multiplier: currentMultiplier,
    payout: netPayout
  };
}

// Deterministic Provably Fair Continuous Timeline Engine for Serverless Environments
function getDeterministicBots(roundId) {
  const bots = [];
  const hash = crypto.createHash('md5').update(`bots-${roundId}`).digest('hex');
  const count = (parseInt(hash.substring(0, 2), 16) % 8) + 5; // 5 to 12 bots
  for (let i = 0; i < count; i++) {
    const subHash = crypto.createHash('md5').update(`bot-${roundId}-${i}`).digest('hex');
    const nameIdx = parseInt(subHash.substring(0, 2), 16) % BOT_NAMES.length;
    const name = BOT_NAMES[nameIdx] + '***';
    const stake = (parseInt(subHash.substring(2, 6), 16) % 190 + 10) * 10;
    const rawTarget = 1.1 + (parseInt(subHash.substring(6, 10), 16) % 400) / 100;
    const autoCashoutMultiplier = parseFloat(rawTarget.toFixed(2));
    bots.push({
      userId: name,
      stake,
      autoCashoutMultiplier,
      cashed: false
    });
  }
  return bots;
}

function getDeterministicRound(now = Date.now()) {
  const DAY_MS = 86400000;
  const dayAnchor = Math.floor(now / DAY_MS) * DAY_MS;
  const SECRET_SALT = 'betpro-aviator-provably-fair-v2';

  // Fast L1 cache: if currentRound is already set in memory and valid for `now`
  if (currentRound && currentRound.endTime && now >= currentRound.startTime && now < currentRound.endTime) {
    if (now < currentRound.takeoffTime) {
      phase = 'BETTING';
      roundTimer = Math.max(0, currentRound.takeoffTime - now);
    } else if (now < currentRound.crashTime) {
      phase = 'FLYING';
      roundTimer = 0;
      takeoffTime = currentRound.takeoffTime;
      crashTime = currentRound.crashTime;
    } else {
      phase = 'CRASHED';
      roundTimer = 0;
      crashTime = currentRound.crashTime;
    }
    return currentRound;
  }

  let t = dayAnchor;
  let idx = 0;

  while (t <= now) {
    const hmac = crypto.createHmac('sha256', SECRET_SALT)
                       .update(`${dayAnchor}-${idx}`)
                       .digest('hex');
    const h = parseInt(hmac.substring(0, 13), 16);
    const e = Math.pow(2, 52);

    let crashPoint;
    if (h % 28 === 0) {
      crashPoint = 1.00;
    } else {
      crashPoint = Math.floor((100 * e - h) / (e - h)) / 100;
    }
    crashPoint = Math.max(1.00, Math.min(1000, parseFloat(crashPoint.toFixed(2))));

    const flightMs = getMsForMultiplier(crashPoint);
    const roundDuration = 6000 + flightMs + 3000; // 6s betting + flight + 3s crash

    if (t + roundDuration > now) {
      const startTime = t;
      const takeoff = startTime + 6000;
      const crash = takeoff + flightMs;
      const end = crash + 3000;

      const roundId = `AV-${Math.round(startTime)}`;

      // Deterministic bot bets seeded by roundId
      const bots = getDeterministicBots(roundId);

      currentRound = {
        roundId,
        index: idx,
        status: now < takeoff ? 'BETTING_OPEN' : now < crash ? 'FLYING' : 'CRASHED',
        startTime,
        takeoffTime: takeoff,
        crashTime: crash,
        endTime: end,
        flightDuration: flightMs,
        serverSeed: hmac,
        serverSeedHash: crypto.createHash('sha256').update(hmac).digest('hex'),
        clientSeed: 'betproexchange',
        nonce: idx,
        crashPoint,
        bots
      };

      takeoffTime = takeoff;
      crashTime = crash;
      virtualBets = bots;

      if (now < takeoff) {
        phase = 'BETTING';
        roundTimer = Math.max(0, takeoff - now);
      } else if (now < crash) {
        phase = 'FLYING';
        roundTimer = 0;
      } else {
        phase = 'CRASHED';
        roundTimer = 0;
      }

      if (mongoose.connection.readyState === 1) {
        AviatorRound.findOne({ roundId }).then(doc => {
          if (!doc) {
            new AviatorRound({
              roundId,
              status: currentRound.status,
              startTime: new Date(startTime),
              endTime: new Date(end),
              serverSeed: hmac,
              serverSeedHash: currentRound.serverSeedHash,
              clientSeed: 'betproexchange',
              nonce: idx,
              crashPoint
            }).save().catch(() => {});
          }
        }).catch(() => {});
      }

      return currentRound;
    }

    t += roundDuration;
    idx++;
  }
}

// ─── Deterministic Round Synchronization (Pure Vercel Serverless Resilient) ───────
function ensureLiveRound(now = Date.now()) {
  return getDeterministicRound(now);
}

function getCurrentState(now = Date.now()) {
  const round = ensureLiveRound(now);

  let currentPhase = 'BETTING';
  let elapsedMs = 0;
  let multiplier = 1.00;
  let timer = 0;

  if (now < round.takeoffTime) {
    currentPhase = 'BETTING';
    timer = Math.max(0, round.takeoffTime - now);
    multiplier = 1.00;
  } else if (now < round.crashTime) {
    currentPhase = 'FLYING';
    elapsedMs = now - round.takeoffTime;
    multiplier = getMultiplierAt(elapsedMs);
    timer = 0;
  } else {
    currentPhase = 'CRASHED';
    multiplier = round.crashPoint;
    timer = 0;
  }

  // Synchronized snapshot of bots
  const botsSnapshot = (round.bots || virtualBets || []).map(b => {
    const isCashed = currentPhase === 'FLYING' ? (multiplier >= b.autoCashoutMultiplier && b.autoCashoutMultiplier < round.crashPoint) : (currentPhase === 'CRASHED' && b.autoCashoutMultiplier < round.crashPoint);
    return {
      userId: b.userId,
      stake: b.stake,
      autoCashoutMultiplier: b.autoCashoutMultiplier,
      cashed: isCashed,
      multiplier: isCashed ? b.autoCashoutMultiplier : null,
      payout: isCashed ? Math.round(b.stake * b.autoCashoutMultiplier) : 0
    };
  });

  return {
    roundId: round.roundId,
    phase: currentPhase,
    elapsedMs,
    multiplier,
    timer,
    startTime: round.startTime,
    takeoffTime: round.takeoffTime,
    crashTime: round.crashTime,
    crashPoint: currentPhase === 'CRASHED' ? round.crashPoint : null,
    endTime: round.endTime,
    serverSeedHash: round.serverSeedHash,
    serverSeed: currentPhase === 'CRASHED' ? round.serverSeed : null,
    history: history.length > 0 ? history : [1.85, 2.14, 1.25, 4.50, 1.12, 3.20, 1.68, 5.40],
    bots: botsSnapshot,
    serverTimestamp: now
  };
}

function getCurrentRound() {
  return currentRound || ensureLiveRound(Date.now());
}

module.exports = {
  initAviatorManager,
  placeBet,
  cashout,
  ensureLiveRound,
  getCurrentRound,
  getCurrentState,
  getMultiplierAt,
  getMsForMultiplier,
  generateProvablyFairRound
};
