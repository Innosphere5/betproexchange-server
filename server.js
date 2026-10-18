const express = require('express');
console.log("==========================================");
console.log("!!! ANTIGRAVITY BACKEND CODE LOADED !!!");
console.log("==========================================");
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
require('dotenv').config();

const compression = require('compression');
const User = require('./models/User');
const Match = require('./models/Match');
const Bet = require('./models/Bet');
const CasinoBet = require('./models/CasinoBet');
const { initRoundManager, getCurrentRound } = require('./services/roundManager');
const { initAviatorManager } = require('./services/aviatorManager');
const { initAviatorxManager } = require('./services/aviatorxManager');
const { initTeenPattiManager } = require('./services/teenPattiManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;
app.set('io', io);

const matchRoutes = require('./routes/matchRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const adminRoutes = require('./routes/adminRoutes');
const aviatorRoutes = require('./routes/aviatorRoutes');
const aviatorxRoutes = require('./routes/aviatorxRoutes');
const teenPattiRoutes = require('./routes/teenPattiRoutes');
const auth = require('./middleware/auth');

app.use(compression());
app.use(cors({
  origin: true, // Reflects the origin of the request (safe for dev)
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api/matches', matchRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/aviator', aviatorRoutes);
app.use('/api/aviatorx', aviatorxRoutes);
app.use('/api/teenpatti', teenPattiRoutes);

// Official GET /v4/scores endpoint as specified by oddsapi.io
app.get(['/v4/scores', '/api/scores'], async (req, res) => {
  const fixtureId = req.query.fixtureId;
  if (!fixtureId) {
    return res.status(400).json({ error: { message: 'fixtureId is required', code: 'MISSING_PARAM' } });
  }
  try {
    const oddsApiRest = require('./services/oddsApiRest');
    const data = await oddsApiRest.getScores(fixtureId);
    return res.status(200).json(data);
  } catch (err) {
    const Match = require('./models/Match');
    const altMatchId = String(fixtureId).startsWith('id') ? String(fixtureId).replace(/^id/, '') : ('id' + String(fixtureId));
    const match = await Match.findOne({
      $or: [{ matchId: { $in: [fixtureId, altMatchId] } }, { oddsApiEventId: { $in: [fixtureId, altMatchId] } }]
    });
    if (match) {
      if (match.score?.periods && Object.keys(match.score.periods).length > 0) {
        return res.status(200).json({ fixtureId, scores: match.score.periods });
      }
      const p1 = parseInt(String(match.score?.teamA_runs || '0').split(/[\/-]/)[0], 10) || 0;
      const p2 = parseInt(String(match.score?.teamB_runs || '0').split(/[\/-]/)[0], 10) || 0;
      const nowIso = (match.score?.lastUpdated || new Date()).toISOString();
      return res.status(200).json({
        fixtureId,
        scores: {
          "0": { participant1Score: p1, participant2Score: p2, updatedAt: nowIso },
          "1": { participant1Score: p1, participant2Score: 0, updatedAt: nowIso },
          "2": { participant1Score: 0, participant2Score: p2, updatedAt: nowIso }
        }
      });
    }
    return res.status(404).json({ error: { message: 'Fixture scores not found', code: 'NOT_FOUND' } });
  }
});

// MongoDB Connection Options
mongoose.set('bufferCommands', true);

mongoose.connect(process.env.MONGO_URI, {
  autoIndex: false,
  maxPoolSize: 20,
  minPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 10000,
})
  .then(async () => {
    console.log('✅ MongoDB connected successfully');

    // Initialize Casino Round Manager with Socket.io
    initRoundManager(io);

    // Initialize Aviator Manager with Socket.io
    initAviatorManager(io);

    // Initialize AviatorX Manager with Socket.io
    initAviatorxManager(io);

    // Initialize Teen Patti Manager with Socket.io
    initTeenPattiManager(io);

    // Initial fetch
    const { fetchUpcomingMatches } = require('./services/matchService');
    fetchUpcomingMatches(io);

    // Start Cron Jobs (after DB connection)
    const { initMatchFetchJob } = require('./jobs/matchFetch.job');
    initMatchFetchJob(io);
    const { initStatusJob } = require('./jobs/statusUpdate.job');
    initStatusJob(io);
    const { initLiveScoreJob } = require('./jobs/liveScoreJob');
    initLiveScoreJob(io);
    const { initSettlementJob } = require('./jobs/settlementJob');
    initSettlementJob(io);
    // Initialize odds-api.io v3 Real-Time Odds (WebSocket + REST recovery)
    const oddsApiLiveService = require('./services/oddsApiLiveService');
    oddsApiLiveService.init(io);

    // Initialize Fancy, Figure, Even-Odd, and Tied Match markets real-time engine
    const fancyMarketsService = require('./services/fancyMarketsService');
    fancyMarketsService.init(io);

    // Initialize Toss Odds Engine (synthetic toss market)
    const { initTossOddsEngine } = require('./services/tossOddsEngine');
    initTossOddsEngine(io);

    // START SERVER ONLY AFTER DB IS READY
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Backend server running on port ${PORT} (All Interfaces)`);
    });

  })
  .catch(err => {
    console.error('❌ MongoDB Connection/Init Error:');
    console.error(err.stack);
  });

app.get('/', (req, res) => {
  res.send('server working');
});

// Wallet Endpoint
app.get('/api/user/wallet', auth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user.userId });
    res.json({
      balance: user ? user.walletBalance : 0,
      credit: user ? (user.credit || 0) : 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Bet Placement Endpoint
app.post('/api/user/bet', auth, async (req, res) => {
  try {
    const { matchId, runner, stake, odds, isLive, type, marketType } = req.body;
    if (!matchId) return res.status(400).json({ error: 'Missing matchId' });
    if (!stake || isNaN(stake) || stake <= 0) return res.status(400).json({ error: 'Invalid stake' });

    // Validate that the match exists in the database from real API feed
    const altMatchId = String(matchId).startsWith('id') ? String(matchId).replace(/^id/, '') : ('id' + String(matchId));
    const matchInDb = await Match.findOne({ matchId: { $in: [matchId, altMatchId] } });
    if (!matchInDb) {
      return res.status(404).json({ error: 'Match not found or is no longer available' });
    }
    if (matchInDb.status === 'completed' || matchInDb.status === 'cancelled') {
      return res.status(400).json({ error: 'This match has already concluded' });
    }
    if (marketType === 'bookmaker' && matchInDb.bookmakerMarketStatus === 'CLOSED') {
      return res.status(400).json({ error: 'Bookmaker market is closed for this match' });
    }
    if (matchInDb.marketStatus === 'CLOSED') {
      return res.status(400).json({ error: 'Market is closed for this match' });
    }

    const officialMatchName = (matchInDb.teamA && matchInDb.teamB) 
      ? `${matchInDb.teamA} v ${matchInDb.teamB}` 
      : (req.body.matchName || 'Cricket Match');

    // Enforce toss market max bet of 2M
    if (marketType === 'toss' && stake > 2000000) {
      return res.status(400).json({ error: 'Toss market max bet is 2M' });
    }

    // Enforce bookmaker market max bet of 1M
    if (marketType === 'bookmaker' && stake > 1000000) {
      return res.status(400).json({ error: 'Bookmaker market max bet is 1M' });
    }

    // Enforce fancy market max bet of 2M
    if (marketType === 'fancy' && stake > 2000000) {
      return res.status(400).json({ error: 'Fancy market max bet is 2M' });
    }

    // Enforce figure market max bet of 100K
    if (marketType === 'figure' && stake > 100000) {
      return res.status(400).json({ error: 'Figure market max bet is 100K' });
    }

    // Enforce even/odd market max bet of 2M
    if (marketType === 'even_odd' && stake > 2000000) {
      return res.status(400).json({ error: 'Even/Odd market max bet is 2M' });
    }

    // Enforce tied match market max bet of 500K
    if (marketType === 'tied_match' && stake > 500000) {
      return res.status(400).json({ error: 'Tied Match market max bet is 500K' });
    }

    const betType = (type || 'back').toLowerCase();
    const liability = (betType === 'lay' && odds > 1) ? Math.round(stake * (odds - 1)) : stake;

    const user = await User.findOneAndUpdate(
      { username: req.user.userId, walletBalance: { $gte: liability } },
      { $inc: { walletBalance: -liability } },
      { returnDocument: 'after' }
    );

    if (!user) return res.status(400).json({ error: 'Insufficient balance for bet liability' });

    const newBet = new Bet({
      userId: req.user.userId,
      matchId,
      matchName: officialMatchName,
      runner,
      stake,
      odds,
      isLive: Boolean(isLive),
      type: type || 'back',
      marketType: marketType || 'match_odds',
      status: 'MATCHED'
    });
    await newBet.save();

    if (io) {
      io.emit('bet_placed', { matchId, bet: newBet });
      io.emit('wallet_updated', { userId: req.user.userId, balance: user.walletBalance });
    }

    res.json({ success: true, balance: user.walletBalance, bet: newBet });
  } catch (err) {
    console.error('[BET PLACEMENT ERROR]', err);
    res.status(500).json({ error: err.message || 'Bet placement failed' });
  }
});

// Casino Bet Placement Endpoint
app.post('/api/casino/bet', auth, async (req, res) => {
  try {
    const { choice, amount } = req.body;
    const currentRound = getCurrentRound();

    if (!currentRound || currentRound.status !== 'BETTING_OPEN') {
      return res.status(400).json({ error: 'Betting is currently closed' });
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid stake amount' });
    }

    // Atomic update to deduct wallet
    const user = await User.findOneAndUpdate(
      { username: req.user.userId, walletBalance: { $gte: amount } },
      { $inc: { walletBalance: -amount } },
      { new: true }
    );

    if (!user) return res.status(400).json({ error: 'Insufficient balance' });

    // Record the casino bet
    const newBet = new CasinoBet({
      userId: req.user.userId,
      roundId: currentRound.roundId,
      choice,
      amount,
      odds: 2.0, // Default for Solitaire/TeenPatti styles
      status: 'PENDING'
    });
    await newBet.save();

    res.json({ success: true, balance: user.walletBalance, roundId: currentRound.roundId });
  } catch (err) {
    console.error("Casino Bet Error:", err);
    res.status(500).json({ error: 'Casino bet failed' });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('SERVER ERROR:', err);

  // Handle specific body-parser errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Capture uncaught exceptions to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION! Shutting down...');
  console.error(err.name, err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('💥 UNHANDLED REJECTION! Shutting down...');
  console.error(err.name, err.message);
  console.error(err.stack);
  process.exit(1);
});


