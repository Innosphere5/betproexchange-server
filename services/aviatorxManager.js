const crypto = require('crypto');
const mongoose = require('mongoose');
const AviatorXRound = require('../models/AviatorXRound');
const AviatorXBet = require('../models/AviatorXBet');
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
let roundBets = []; // In-memory real player bets for current round
const activePlayers = new Set();

const BETTING_DURATION = 6000; // 6 seconds betting window
const CRASHED_DURATION = 3000; // 3 seconds show crash window

// 1.06^t growth curve
function getMultiplierAt(elapsedMs) {
  const seconds = elapsedMs / 1000;
  return parseFloat(Math.pow(1.06, seconds).toFixed(2));
}

// Calculate the precise ms at which a multiplier crashes
function getMsForMultiplier(multiplier) {
  if (multiplier <= 1.00) return 0;
  return (Math.log(multiplier) / Math.log(1.06)) * 1000;
}

// Provably Fair Crash Point Generation
function generateProvablyFairRound(nonce) {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const clientSeed = 'betproexchange'; // Default site salt
  
  const hash = crypto.createHmac('sha256', serverSeed)
                     .update(`${clientSeed}-${nonce}`)
                     .digest('hex');
  
  const h = parseInt(hash.substring(0, 13), 16);
  const e = Math.pow(2, 52);
  
  let crashPoint;
  // 3% house edge: 3% of rounds crash instantly at 1.00
  if (h % 33 === 0) {
    crashPoint = 1.00;
  } else {
    crashPoint = Math.floor((100 * e - h) / (e - h)) / 100;
  }
  
  crashPoint = Math.max(1.00, parseFloat(crashPoint.toFixed(2)));
  
  return {
    serverSeed,
    serverSeedHash,
    clientSeed,
    crashPoint
  };
}

async function loadHistory() {
  try {
    const pastRounds = await AviatorXRound.find({ status: 'CRASHED' })
                                         .sort({ endTime: -1 })
                                         .limit(20);
    if (pastRounds && pastRounds.length > 0) {
      history = pastRounds.map(r => r.crashPoint).reverse();
    } else if (history.length === 0) {
      history = [2.45, 1.68, 3.12, 1.24, 7.40, 1.60, 2.59, 1.24, 2.30, 1.91];
    }
  } catch (err) {
    console.warn('[AVIATORX] Error loading history (using fallback):', err.message);
    if (history.length === 0) {
      history = [2.45, 1.68, 3.12, 1.24, 7.40, 1.60, 2.59, 1.24, 2.30, 1.91];
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
  
  io.to('aviatorx').emit('aviatorx_state', {
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

function initAviatorxManager(socketIo) {
  io = socketIo;
  loadHistory();

  // On boot, start in IDLE state. Engine runs ONLY when players are present and ready!
  phase = 'IDLE';

  io.on('connection', (socket) => {
    const handlePlayerReady = () => {
      socket.join('aviatorx');
      activePlayers.add(socket.id);
      console.log(`[AVIATORX] Socket ${socket.id} joined/ready. Active players: ${activePlayers.size}`);

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
        socket.emit('aviatorx_state', {
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

    socket.on('join_aviatorx', handlePlayerReady);
    socket.on('aviatorx_ready', handlePlayerReady);

    const handlePlayerLeave = () => {
      socket.leave('aviatorx');
      activePlayers.delete(socket.id);
      console.log(`[AVIATORX] Socket ${socket.id} left. Active players: ${activePlayers.size}`);

      // If no players remain in room and game is currently in BETTING phase with no bets placed, pause immediately to IDLE
      if (activePlayers.size === 0 && phase === 'BETTING') {
        AviatorXBet.countDocuments({ roundId: currentRound?.roundId, status: 'PENDING' })
          .then(count => {
            if (count === 0 && activePlayers.size === 0 && phase === 'BETTING') {
              console.log('[AVIATORX] All players left with no bets. Entering IDLE state.');
              clearInterval(timerInterval);
              phase = 'IDLE';
              currentRound = null;
              broadcastState();
            }
          })
          .catch(() => {});
      }
    };

    socket.on('leave_aviatorx', handlePlayerLeave);
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
    roundBets = []; // Reset in-memory bets for new round
    
    const nonce = Date.now();
    const fairData = generateProvablyFairRound(nonce);
    const roundId = `AVX-${Date.now()}`;

    const roundDoc = new AviatorXRound({
      roundId,
      status: 'BETTING_OPEN',
      serverSeed: fairData.serverSeed,
      serverSeedHash: fairData.serverSeedHash,
      clientSeed: fairData.clientSeed,
      nonce,
      crashPoint: fairData.crashPoint
    });
    
    currentRound = roundDoc;
    roundDoc.save().catch(err => console.warn('[AVIATORX] DB save warning:', err.message));
    console.log(`[AVIATORX] New round: ${roundId} | CrashPoint: ${fairData.crashPoint} | Commit: ${fairData.serverSeedHash}`);

    // Immediately broadcast BETTING state so all clients start 6.0s countdown
    broadcastState();

    const startTimestamp = Date.now();
    timerInterval = setInterval(() => {
      const elapsed = Date.now() - startTimestamp;
      roundTimer = Math.max(0, BETTING_DURATION - elapsed);
      broadcastState();
      
      if (roundTimer <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        startFlyingPhase();
      }
    }, 100);
    if (timerInterval.unref) timerInterval.unref();
  } catch (err) {
    console.error('[AVIATORX] Error in betting phase initialization:', err);
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
        currentRound.save().catch(err => console.warn('[AVIATORX] Save flying warning:', err.message));
      }
    }
    
    // Exact crash time derived from crashPoint
    const crashPoint = currentRound ? currentRound.crashPoint : 1.5;
    const flightDuration = getMsForMultiplier(crashPoint);
    crashTime = takeoffTime + flightDuration;
    console.log(`[AVIATORX] Plane flying. Expected crash in ${flightDuration.toFixed(0)}ms at ${crashPoint}x`);

    // Broadcast FLYING state immediately on takeoff
    broadcastState();

    // Fallback sync: if in-memory roundBets is empty, load active bets once
    if (roundBets.length === 0 && currentRound && mongoose.connection.readyState === 1) {
      AviatorXBet.find({ roundId: currentRound.roundId, status: 'PENDING' })
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

        broadcastState();
      }
    }, 50);
    if (tickInterval.unref) tickInterval.unref();
  } catch (err) {
    console.error('[AVIATORX] Error starting flying phase:', err);
    startBettingPhase();
  }
}

async function processAutoCashout(bet, actualMultiplier) {
  try {
    const grossPayout = Math.round(bet.stake * actualMultiplier * 100) / 100;
    const netProfit = Math.round((grossPayout - bet.stake) * 0.98 * 100) / 100;
    const { netProfit: cappedNetProfit } = await capProfitByLimit(bet.userId, 'aviatorX', netProfit);
    const netPayout = bet.stake + cappedNetProfit;

    const updatedBet = await AviatorXBet.findOneAndUpdate(
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
        await distributeCasinoPL(bet.userId, -cappedNetProfit, {
          matchName: `AviatorX Round ${currentRound ? currentRound.roundId : ''}`,
          selection: `Won @ Auto-Cashout ${actualMultiplier}x`
        });

        io.emit('wallet_updated', { userId: bet.userId, balance: user.walletBalance });
        io.to('aviatorx').emit('aviatorx_cashout_success', {
          userId: bet.userId,
          betSlot: bet.betSlot,
          multiplier: actualMultiplier,
          payout: netPayout
        });
        console.log(`[AVIATORX] Auto-Cashout hit for ${bet.userId} | Multiplier: ${actualMultiplier}x | NetPayout: ${netPayout}`);
      }
    }
  } catch (err) {
    console.error('[AVIATORX] Error processing auto-cashout:', err);
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
        currentRound.save().catch(err => console.warn('[AVIATORX] Save crash warning:', err.message));
      }
      console.log(`[AVIATORX] Round crashed at ${finalMultiplier}x. Seed revealed: ${currentRound.serverSeed}`);
    }
    
    // Add to cache history
    history.push(finalMultiplier);
    if (history.length > 20) history.shift();

    // Mark remaining in-memory bets as LOST
    roundBets.forEach(b => {
      if (b.status === 'PENDING') {
        b.status = 'LOST';
      }
    });

    // Settle all uncashed active bets in this round as LOSS
    if (currentRound && mongoose.connection.readyState === 1) {
      const uncashedBets = await AviatorXBet.find({
        roundId: currentRound.roundId,
        status: 'PENDING'
      });

      for (const bet of uncashedBets) {
        bet.status = 'LOST';
        await bet.save();

        await distributeCasinoPL(bet.userId, bet.stake, {
          matchName: `AviatorX Round ${currentRound.roundId}`,
          selection: `Lost @ Crash ${finalMultiplier}x`
        });
        
        console.log(`[AVIATORX] Settled lost bet for user ${bet.userId} | Stake: ${bet.stake}`);
      }
    }

    broadcastState();

    // Autonomous loop only continues if players are active in the room!
    setTimeout(() => {
      if (activePlayers.size > 0) {
        startBettingPhase();
      } else {
        console.log('[AVIATORX] No active players in room. Entering IDLE phase.');
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
    console.error('[AVIATORX] Error triggering crash:', err);
    if (activePlayers.size > 0) {
      setTimeout(startBettingPhase, 5000);
    } else {
      phase = 'IDLE';
      currentRound = null;
      broadcastState();
    }
  }
}

// REST endpoints helper functions
async function placeBet(userId, betSlot, stake, autoCashoutMultiplier) {
  if (phase === 'IDLE' || phase === 'INIT') {
    await startBettingPhase();
  } else if (!currentRound || phase !== 'BETTING') {
    throw new Error('Betting is closed for this round');
  }
  
  if (!stake || isNaN(stake) || stake < 10) {
    throw new Error('Invalid stake amount (minimum 10)');
  }

  // Validate hierarchical max bet size & profit limit for Aviator X
  const estimatedProfit = autoCashoutMultiplier ? Math.round(stake * (parseFloat(autoCashoutMultiplier) - 1)) : 0;
  await validateBetLimit(userId, 'aviatorX', stake, estimatedProfit);

  // Fast in-memory double-bet validation
  const memExisting = roundBets.find(b => b.userId === userId && Number(b.betSlot) === Number(betSlot));
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

  const numSlot = Number(betSlot);
  const bet = new AviatorXBet({
    userId,
    roundId: currentRound.roundId,
    betSlot: numSlot,
    stake: parseFloat(stake),
    autoCashoutMultiplier: autoCashoutMultiplier ? parseFloat(autoCashoutMultiplier) : null,
    status: 'PENDING'
  });

  // Save bet to database asynchronously in background without blocking response
  bet.save().catch(err => console.warn('[AVIATORX] Bet save warning:', err.message));

  roundBets.push({
    _id: bet._id,
    userId,
    roundId: currentRound.roundId,
    betSlot: numSlot,
    stake: parseFloat(stake),
    autoCashoutMultiplier: autoCashoutMultiplier ? parseFloat(autoCashoutMultiplier) : null,
    status: 'PENDING',
    cashed: false,
    payout: 0,
    cashoutMultiplier: null
  });

  // Notify wallet and place event
  io.emit('wallet_updated', { userId, balance: user.walletBalance });
  io.to('aviatorx').emit('aviatorx_bet_placed', {
    userId,
    betSlot: numSlot,
    stake: parseFloat(stake),
    autoCashoutMultiplier: autoCashoutMultiplier ? parseFloat(autoCashoutMultiplier) : null
  });

  return { success: true, balance: user.walletBalance, bet };
}

async function cashout(userId, betSlot) {
  if (!currentRound || phase !== 'FLYING') {
    throw new Error('Game is not currently flying');
  }

  const numSlot = Number(betSlot);
  const now = Date.now();
  if (now >= crashTime) {
    throw new Error('Game has already crashed');
  }

  const elapsedMs = now - takeoffTime;
  const currentMultiplier = getMultiplierAt(elapsedMs);

  // Fast in-memory resolution first for zero-latency crash game performance
  let memBet = roundBets.find(b => b.userId === userId && Number(b.betSlot) === numSlot);
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
    let bet = await AviatorXBet.findOne({
      userId,
      roundId: currentRound.roundId,
      betSlot: numSlot,
      status: 'PENDING'
    });

    if (!bet) {
      const wonBet = await AviatorXBet.findOne({
        userId,
        roundId: currentRound.roundId,
        betSlot: numSlot,
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

      const lostBet = await AviatorXBet.findOne({
        userId,
        roundId: currentRound.roundId,
        betSlot: numSlot,
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
  const rawNetProfit = Math.round((grossPayout - stake) * 0.98 * 100) / 100;
  const { netProfit } = await capProfitByLimit(userId, 'aviatorX', rawNetProfit);
  const netPayout = stake + netProfit;

  // Immediate in-memory lock to guarantee single settlement
  if (memBet) {
    memBet.cashed = true;
    memBet.status = 'WON';
    memBet.cashoutMultiplier = currentMultiplier;
    memBet.payout = netPayout;
  }

  // Real-time broadcast to room immediately
  io.to('aviatorx').emit('aviatorx_cashout_success', {
    userId,
    betSlot: numSlot,
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
    AviatorXBet.findOneAndUpdate(
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
    matchName: `AviatorX Round ${currentRound.roundId}`,
    selection: `Won @ Cashout ${currentMultiplier}x`
  }).catch(err => console.error('[AviatorX distributeCasinoPL]', err));

  return {
    success: true,
    balance: user ? user.walletBalance : 0,
    multiplier: currentMultiplier,
    payout: netPayout
  };
}

// ─── Deterministic Round Synchronization (Pure Vercel Serverless Resilient) ───────
function ensureLiveRound(now = Date.now()) {
  // If currentRound exists and hasn't reached its complete cycle (endTime)
  if (currentRound && currentRound.endTime && now < currentRound.endTime) {
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

  // Current round has expired or does not exist yet. Settle old round and advance:
  if (currentRound && currentRound.crashPoint) {
    if (!history.includes(currentRound.crashPoint)) {
      history.push(currentRound.crashPoint);
      if (history.length > 30) history.shift();
    }
    if (mongoose.connection.readyState === 1) {
      AviatorXBet.updateMany(
        { roundId: currentRound.roundId, status: 'PENDING' },
        { status: 'LOST' }
      ).catch(() => {});
    }
  }

  const nonce = now;
  const fairData = generateProvablyFairRound(nonce);
  const roundId = `AX-${now}`;
  const startTime = now;
  const takeoff = startTime + BETTING_DURATION; // 6000ms
  const flightDuration = getMsForMultiplier(fairData.crashPoint);
  const crash = takeoff + flightDuration;
  const end = crash + CRASHED_DURATION; // 3000ms

  takeoffTime = takeoff;
  crashTime = crash;
  phase = 'BETTING';
  roundTimer = BETTING_DURATION;
  virtualBets = [];
  roundBets = [];

  // Generate realistic bot bets
  const botCount = Math.floor(Math.random() * 8) + 4;
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
    const roundDoc = new AviatorXRound({
      roundId,
      status: 'BETTING_OPEN',
      startTime: new Date(startTime),
      serverSeed: fairData.serverSeed,
      serverSeedHash: fairData.serverSeedHash,
      clientSeed: fairData.clientSeed,
      nonce,
      crashPoint: fairData.crashPoint
    });
    roundDoc.save().catch(err => console.warn('[AVIATORX] DB round save warning:', err.message));
  }

  return currentRound;
}

function getCurrentState() {
  const now = Date.now();
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
  const botsSnapshot = virtualBets.map(b => {
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
    history: history.length > 0 ? history : [2.14, 1.45, 3.80, 1.15, 6.20, 1.88],
    bots: botsSnapshot,
    serverTimestamp: now
  };
}

function getCurrentRound() {
  return currentRound || ensureLiveRound(Date.now());
}

function getActiveBets(userId) {
  const round = currentRound || ensureLiveRound(Date.now());
  if (!round) return [];
  return roundBets.filter(b => b.userId === userId && b.roundId === round.roundId);
}

module.exports = {
  initAviatorxManager,
  placeBet,
  cashout,
  ensureLiveRound,
  getCurrentRound,
  getCurrentState,
  getActiveBets,
  getMultiplierAt,
  getMsForMultiplier,
  generateProvablyFairRound
};
