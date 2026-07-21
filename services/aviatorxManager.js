const crypto = require('crypto');
const AviatorXRound = require('../models/AviatorXRound');
const AviatorXBet = require('../models/AviatorXBet');
const User = require('../models/User');
const { distributeCasinoPL } = require('./hierarchyService');

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
    history = pastRounds.map(r => r.crashPoint).reverse();
  } catch (err) {
    console.error('[AVIATORX] Error loading history:', err);
  }
}

function broadcastState() {
  if (!io || !currentRound) return;
  
  const now = Date.now();
  let elapsedMs = 0;
  let multiplier = 1.00;
  
  if (phase === 'FLYING' && takeoffTime) {
    elapsedMs = now - takeoffTime;
    multiplier = getMultiplierAt(elapsedMs);
  }
  
  io.to('aviatorx').emit('aviatorx_state', {
    roundId: currentRound.roundId,
    phase,
    elapsedMs,
    multiplier,
    timer: roundTimer,
    serverSeedHash: currentRound.serverSeedHash,
    serverSeed: phase === 'CRASHED' ? currentRound.serverSeed : null,
    crashPoint: phase === 'CRASHED' ? currentRound.crashPoint : null,
    history,
    serverTimestamp: now
  });
}

function initAviatorxManager(socketIo) {
  io = socketIo;
  loadHistory();

  io.on('connection', (socket) => {
    // Send state on connection if inside AviatorX
    socket.on('join_aviatorx', () => {
      socket.join('aviatorx');
      activePlayers.add(socket.id);
      console.log(`[AVIATORX] Socket ${socket.id} joined. Active: ${activePlayers.size}`);
      
      // Send immediate sync
      if (currentRound) {
        const now = Date.now();
        let elapsedMs = 0;
        let multiplier = 1.00;
        if (phase === 'FLYING' && takeoffTime) {
          elapsedMs = now - takeoffTime;
          multiplier = getMultiplierAt(elapsedMs);
        }
        socket.emit('aviatorx_state', {
          roundId: currentRound.roundId,
          phase,
          elapsedMs,
          multiplier,
          timer: roundTimer,
          serverSeedHash: currentRound.serverSeedHash,
          serverSeed: phase === 'CRASHED' ? currentRound.serverSeed : null,
          crashPoint: phase === 'CRASHED' ? currentRound.crashPoint : null,
          history,
          serverTimestamp: now
        });
      }
      
      // Auto-start loop if first player joins
      if (activePlayers.size === 1 && phase === 'INIT') {
        startBettingPhase();
      }
    });

    socket.on('leave_aviatorx', () => {
      socket.leave('aviatorx');
      activePlayers.delete(socket.id);
      console.log(`[AVIATORX] Socket ${socket.id} left. Active: ${activePlayers.size}`);
    });

    socket.on('disconnect', () => {
      activePlayers.delete(socket.id);
    });
  });
}

async function startBettingPhase() {
  try {
    clearInterval(tickInterval);
    clearInterval(timerInterval);

    phase = 'BETTING';
    roundTimer = BETTING_DURATION;
    
    const count = await AviatorXRound.countDocuments();
    const nonce = count + 1;
    const fairData = generateProvablyFairRound(nonce);
    const roundId = `AVX-${Date.now()}`;

    currentRound = new AviatorXRound({
      roundId,
      status: 'BETTING_OPEN',
      serverSeed: fairData.serverSeed,
      serverSeedHash: fairData.serverSeedHash,
      clientSeed: fairData.clientSeed,
      nonce,
      crashPoint: fairData.crashPoint
    });
    
    await currentRound.save();
    console.log(`[AVIATORX] New round: ${roundId} | CrashPoint: ${fairData.crashPoint} | Commit: ${fairData.serverSeedHash}`);

    const startTimestamp = Date.now();
    timerInterval = setInterval(() => {
      const elapsed = Date.now() - startTimestamp;
      roundTimer = Math.max(0, BETTING_DURATION - elapsed);
      broadcastState();
      
      if (roundTimer <= 0) {
        clearInterval(timerInterval);
        startFlyingPhase();
      }
    }, 100);
  } catch (err) {
    console.error('[AVIATORX] Error in betting phase initialization:', err);
    setTimeout(startBettingPhase, 5000);
  }
}

async function startFlyingPhase() {
  try {
    phase = 'FLYING';
    takeoffTime = Date.now();
    
    currentRound.status = 'FLYING';
    await currentRound.save();
    
    // Exact crash time derived from crashPoint
    const flightDuration = getMsForMultiplier(currentRound.crashPoint);
    crashTime = takeoffTime + flightDuration;
    console.log(`[AVIATORX] Plane flying. Expected crash in ${flightDuration.toFixed(0)}ms`);

    tickInterval = setInterval(async () => {
      const now = Date.now();
      
      if (now >= crashTime) {
        clearInterval(tickInterval);
        await triggerCrash();
      } else {
        const elapsedMs = now - takeoffTime;
        const currentMultiplier = getMultiplierAt(elapsedMs);
        
        // Evaluate auto-cashout in-flight server-side
        await evaluateAutoCashouts(currentMultiplier);
        broadcastState();
      }
    }, 50);
  } catch (err) {
    console.error('[AVIATORX] Error starting flying phase:', err);
    startBettingPhase();
  }
}

async function evaluateAutoCashouts(currentMultiplier) {
  try {
    const pendingBets = await AviatorXBet.find({
      roundId: currentRound.roundId,
      status: 'PENDING',
      autoCashoutMultiplier: { $ne: null, $lte: currentMultiplier }
    });

    for (const bet of pendingBets) {
      // Fetch user and perform transactional write to settle won auto-cashout
      const now = Date.now();
      const actualMultiplier = bet.autoCashoutMultiplier; // Cashout exactly at their preset
      const grossPayout = Math.round(bet.stake * actualMultiplier * 100) / 100;
      const netProfit = Math.round((grossPayout - bet.stake) * 0.95 * 100) / 100;
      const netPayout = bet.stake + netProfit;

      // Atomic lock and update
      const updatedBet = await AviatorXBet.findOneAndUpdate(
        { _id: bet._id, status: 'PENDING' },
        {
          status: 'WON',
          cashoutMultiplier: actualMultiplier,
          cashoutTime: new Date(now),
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
          // Distribute commission share / house loss up the hierarchy
          await distributeCasinoPL(bet.userId, -netProfit, {
            matchName: `AviatorX Round ${currentRound.roundId}`,
            selection: `Won @ Auto-Cashout ${actualMultiplier}x`
          });

          // Sync wallet and notify
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
    }
  } catch (err) {
    console.error('[AVIATORX] Error evaluating auto-cashouts:', err);
  }
}

async function triggerCrash() {
  try {
    phase = 'CRASHED';
    const finalMultiplier = currentRound.crashPoint;
    currentRound.status = 'CRASHED';
    currentRound.endTime = new Date();
    await currentRound.save();

    console.log(`[AVIATORX] Round crashed at ${finalMultiplier}x. Seed revealed: ${currentRound.serverSeed}`);
    
    // Add to cache history
    history.push(finalMultiplier);
    if (history.length > 20) history.shift();

    // Settle all uncashed active bets in this round as LOSS
    const uncashedBets = await AviatorXBet.find({
      roundId: currentRound.roundId,
      status: 'PENDING'
    });

    for (const bet of uncashedBets) {
      bet.status = 'LOST';
      await bet.save();

      // House Profit = bet.stake. Distribute up parent hierarchy
      await distributeCasinoPL(bet.userId, bet.stake, {
        matchName: `AviatorX Round ${currentRound.roundId}`,
        selection: `Lost @ Crash ${finalMultiplier}x`
      });
      
      console.log(`[AVIATORX] Settled lost bet for user ${bet.userId} | Stake: ${bet.stake}`);
    }

    broadcastState();

    // Pause before resetting
    setTimeout(() => {
      if (activePlayers.size > 0) {
        startBettingPhase();
      } else {
        console.log('[AVIATORX] No active players. Pausing engine loop...');
        phase = 'INIT';
        currentRound = null;
      }
    }, CRASHED_DURATION);
  } catch (err) {
    console.error('[AVIATORX] Error triggering crash:', err);
    setTimeout(startBettingPhase, 5000);
  }
}

// REST endpoints helper functions
async function placeBet(userId, betSlot, stake, autoCashoutMultiplier) {
  if (!currentRound || phase !== 'BETTING') {
    throw new Error('Betting is closed for this round');
  }
  
  if (!stake || isNaN(stake) || stake < 10) {
    throw new Error('Invalid stake amount (minimum 10)');
  }

  // Double-bet validation
  const existing = await AviatorXBet.findOne({
    userId,
    roundId: currentRound.roundId,
    betSlot
  });
  if (existing) {
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

  const bet = new AviatorXBet({
    userId,
    roundId: currentRound.roundId,
    betSlot,
    stake,
    autoCashoutMultiplier: autoCashoutMultiplier ? parseFloat(autoCashoutMultiplier) : null,
    status: 'PENDING'
  });

  await bet.save();

  // Notify wallet and place event
  io.emit('wallet_updated', { userId, balance: user.walletBalance });
  io.to('aviatorx').emit('aviatorx_bet_placed', {
    userId,
    betSlot,
    stake,
    autoCashoutMultiplier
  });

  return { success: true, balance: user.walletBalance, bet };
}

async function cashout(userId, betSlot) {
  if (!currentRound || phase !== 'FLYING') {
    throw new Error('Game is not currently flying');
  }

  const now = Date.now();
  if (now >= crashTime) {
    throw new Error('Game has already crashed');
  }

  const elapsedMs = now - takeoffTime;
  const currentMultiplier = getMultiplierAt(elapsedMs);

  const bet = await AviatorXBet.findOne({
    userId,
    roundId: currentRound.roundId,
    betSlot,
    status: 'PENDING'
  });

  if (!bet) {
    throw new Error('Active bet not found');
  }

  const grossPayout = Math.round(bet.stake * currentMultiplier * 100) / 100;
  const netProfit = Math.round((grossPayout - bet.stake) * 0.95 * 100) / 100;
  const netPayout = bet.stake + netProfit;

  // Atomic state protection
  const updatedBet = await AviatorXBet.findOneAndUpdate(
    { _id: bet._id, status: 'PENDING' },
    {
      status: 'WON',
      cashoutMultiplier: currentMultiplier,
      cashoutTime: new Date(now),
      payout: netPayout
    },
    { new: true }
  );

  if (!updatedBet) {
    throw new Error('Bet already cashed out or settled');
  }

  const user = await User.findOneAndUpdate(
    { username: userId },
    { $inc: { walletBalance: netPayout } },
    { new: true }
  );

  if (!user) {
    throw new Error('Failed to update wallet balance');
  }

  // Distribute profit share up the hierarchy
  await distributeCasinoPL(userId, -netProfit, {
    matchName: `AviatorX Round ${currentRound.roundId}`,
    selection: `Won @ Cashout ${currentMultiplier}x`
  });

  io.emit('wallet_updated', { userId, balance: user.walletBalance });
  io.to('aviatorx').emit('aviatorx_cashout_success', {
    userId,
    betSlot,
    multiplier: currentMultiplier,
    payout: netPayout
  });

  return { success: true, balance: user.walletBalance, multiplier: currentMultiplier, payout: netPayout };
}

function getCurrentRound() {
  return currentRound;
}

module.exports = {
  initAviatorxManager,
  placeBet,
  cashout,
  getCurrentRound,
  getMultiplierAt,
  getMsForMultiplier,
  generateProvablyFairRound
};
