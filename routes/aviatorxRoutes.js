const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const aviatorxManager = require('../services/aviatorxManager');
const AviatorXBet = require('../models/AviatorXBet');
const AviatorXRound = require('../models/AviatorXRound');

// Place a bet in the current AviatorX round
router.post('/bet', auth, async (req, res) => {
  try {
    const { betSlot, stake, autoCashoutMultiplier } = req.body;
    const userId = req.user.userId;

    if (![1, 2].includes(betSlot)) {
      return res.status(400).json({ error: 'Invalid bet slot (must be 1 or 2)' });
    }

    const result = await aviatorxManager.placeBet(userId, betSlot, stake, autoCashoutMultiplier);
    res.json(result);
  } catch (err) {
    console.error('[API AVIATORX] Bet failed:', err.message);
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

    const result = await aviatorxManager.cashout(userId, betSlot);
    res.json(result);
  } catch (err) {
    console.error('[API AVIATORX] Cashout failed:', err.message);
    res.status(400).json({ error: err.message || 'Cashout failed' });
  }
});

// Fetch active bets for reconnection flow
router.get('/active-bets', auth, async (req, res) => {
  try {
    const currentRound = aviatorxManager.getCurrentRound();
    if (!currentRound) {
      return res.json([]);
    }

    const bets = await AviatorXBet.find({
      userId: req.user.userId,
      roundId: currentRound.roundId
    });

    res.json(bets);
  } catch (err) {
    console.error('[API AVIATORX] Get active bets failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch historical rounds for the verifier/recent strip
router.get('/history', async (req, res) => {
  try {
    const history = await AviatorXRound.find({ status: 'CRASHED' })
                                       .sort({ endTime: -1 })
                                       .limit(30);
    res.json(history);
  } catch (err) {
    console.error('[API AVIATORX] Get history failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
