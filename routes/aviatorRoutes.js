const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const aviatorManager = require('../services/aviatorManager');
const AviatorBet = require('../models/AviatorBet');
const AviatorRound = require('../models/AviatorRound');

// Place a bet in the current Aviator round
router.post('/bet', auth, async (req, res) => {
  try {
    const { betSlot, stake, autoCashoutMultiplier } = req.body;
    const userId = req.user.userId;

    if (![1, 2].includes(betSlot)) {
      return res.status(400).json({ error: 'Invalid bet slot (must be 1 or 2)' });
    }

    const result = await aviatorManager.placeBet(userId, betSlot, stake, autoCashoutMultiplier);
    res.json(result);
  } catch (err) {
    console.error('[API AVIATOR] Bet failed:', err.message);
    res.status(400).json({ error: err.message || 'Bet placement failed' });
  }
});

// Cashout an active bet
router.post('/cashout', auth, async (req, res) => {
  try {
    const { betSlot } = req.body;
    const userId = req.user.userId;

    if (![1, 2].includes(betSlot)) {
      return res.status(400).json({ error: 'Invalid bet slot (must be 1 or 2)' });
    }

    const result = await aviatorManager.cashout(userId, betSlot);
    res.json(result);
  } catch (err) {
    console.error('[API AVIATOR] Cashout failed:', err.message);
    res.status(400).json({ error: err.message || 'Cashout failed' });
  }
});

// Fetch active bets for reconnection/page-reload flows
router.get('/active-bets', auth, async (req, res) => {
  try {
    const currentRound = aviatorManager.getCurrentRound();
    if (!currentRound) {
      return res.json([]);
    }

    const bets = await AviatorBet.find({
      userId: req.user.userId,
      roundId: currentRound.roundId
    });

    res.json(bets);
  } catch (err) {
    console.error('[API AVIATOR] Get active bets failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch historical rounds for the strip/fair verifier
router.get('/history', async (req, res) => {
  try {
    const history = await AviatorRound.find({ status: 'CRASHED' })
                                      .sort({ endTime: -1 })
                                      .limit(30);
    res.json(history);
  } catch (err) {
    console.error('[API AVIATOR] Get history failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch top bets and stats (used for settings / leaderboard modals)
router.get('/stats', async (req, res) => {
  try {
    const biggestWins = await AviatorBet.find({ status: 'WON' })
                                       .sort({ payout: -1 })
                                       .limit(10);

    const totalRounds = await AviatorRound.countDocuments({ status: 'CRASHED' });

    res.json({
      biggestWins: biggestWins.map(b => ({
        username: b.userId.substring(0, 4) + '***',
        stake: b.stake,
        multiplier: b.cashoutMultiplier,
        payout: b.payout,
        date: b.createdAt
      })),
      totalRounds
    });
  } catch (err) {
    console.error('[API AVIATOR] Get stats failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
