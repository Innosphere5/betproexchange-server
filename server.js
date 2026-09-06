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
    const { matchId, matchName, runner, stake, odds, isLive, type } = req.body;
    if (!matchId) return res.status(400).json({ error: 'Missing matchId' });
    if (!stake || isNaN(stake) || stake <= 0) return res.status(400).json({ error: 'Invalid stake' });

    const user = await User.findOneAndUpdate(
      { username: req.user.userId, walletBalance: { $gte: stake } },
      { $inc: { walletBalance: -stake } },
      { new: true }
    );

    if (!user) return res.status(400).json({ error: 'Insufficient balance' });

    const newBet = new Bet({
      userId: req.user.userId,
      matchId,
      matchName,
      runner,
      stake,
      odds,
      isLive,
      type: type || 'back',
      status: 'pending'
    });
    await newBet.save();

    res.json({ success: true, balance: user.walletBalance });
  } catch (err) {
    res.status(500).json({ error: 'Bet placement failed' });
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


