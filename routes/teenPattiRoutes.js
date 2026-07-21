const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const teenPattiManager = require('../services/teenPattiManager');
const TeenPattiBet = require('../models/TeenPattiBet');
const TeenPattiHand = require('../models/TeenPattiHand');

// Place a bet in the current Teen Patti round
router.post('/bet', auth, async (req, res) => {
  try {
    const { betType, amount } = req.body;
    const userId = req.user.userId;

    const validTypes = ['A_BACK', 'A_LAY', 'B_BACK', 'B_LAY', 'A_PAIR_PLUS', 'B_PAIR_PLUS'];
    if (!validTypes.includes(betType)) {
      return res.status(400).json({ error: 'Invalid bet type' });
    }

    const result = await teenPattiManager.placeBet(userId, betType, amount);
    res.json(result);
  } catch (err) {
    console.error('[API TEENPATTI] Bet failed:', err.message);
    res.status(400).json({ error: err.message || 'Bet placement failed' });
  }
});

// Fetch active bets for reconnection/page-reload flows
router.get('/active-bets', auth, async (req, res) => {
  try {
    const currentRound = teenPattiManager.getActiveRound();
    if (!currentRound) {
      return res.json([]);
    }

    const bets = await TeenPattiBet.find({
      userId: req.user.userId,
      roundId: currentRound.roundId
    });

    res.json(bets);
  } catch (err) {
    console.error('[API TEENPATTI] Get active bets failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch historical rounds
router.get('/history', async (req, res) => {
  try {
    const history = await TeenPattiHand.find({ status: 'RESULT_DECLARED' })
      .sort({ startTime: -1 })
      .limit(30);
    res.json(history);
  } catch (err) {
    console.error('[API TEENPATTI] Get history failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
