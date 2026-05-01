const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');
const Bet = require('./models/Bet');
const CasinoBet = require('./models/CasinoBet');
const { initRoundManager, getCurrentRound } = require('./services/roundManager');

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
const auth = require('./middleware/auth');

app.use(cors());
app.use(express.json());
app.use('/api/matches', matchRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);

// MongoDB Connection Options
mongoose.set('bufferCommands', false);

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected successfully');
    
    // Initialize Casino Round Manager with Socket.io
    initRoundManager(io);
    
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
  })
  .catch(err => console.error('❌ MongoDB Error:', err.message));

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

server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
