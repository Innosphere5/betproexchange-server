const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const teenPattiManager = require('../services/teenPattiManager');
const TeenPattiBet = require('../models/TeenPattiBet');

// Current Teen Patti live state
router.get('/state', (req, res) => {
  try {
    const state = teenPattiManager.getCurrentState(Date.now());
    res.json(state);
  } catch (err) {
    console.error('[API TEENPATTI] Get state failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Explicit Ready-to-Start trigger
router.post('/ready', auth, async (req, res) => {
  try {
    const state = await teenPattiManager.playerReady({ userId: req.user.userId });
    res.json({ success: true, state });
  } catch (err) {
    console.error('[API TEENPATTI] Ready failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to start Teen Patti table' });
  }
});

// Explicit Leave-Table trigger
router.post('/leave', auth, (req, res) => {
  try {
    const state = teenPattiManager.playerLeave({ userId: req.user.userId });
    res.json({ success: true, state });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to leave table' });
  }
});

// Place a bet in the current Teen Patti round
router.post('/bet', auth, async (req, res) => {
  try {
    const { betType, amount } = req.body;
    const validTypes = ['A_BACK', 'A_LAY', 'B_BACK', 'B_LAY', 'A_PAIR_PLUS', 'B_PAIR_PLUS'];
    if (!validTypes.includes(betType)) {
      return res.status(400).json({ error: 'Invalid bet type' });
    }
    const result = await teenPattiManager.placeBet(req.user.userId, betType, amount);
    res.json(result);
  } catch (err) {
    console.error('[API TEENPATTI] Bet failed:', err.message);
    res.status(400).json({ error: err.message || 'Bet placement failed' });
  }
});

// Fetch active bets for reconnection / page reload
router.get('/active-bets', auth, async (req, res) => {
  try {
    const currentRound = teenPattiManager.getActiveRound();
    if (!currentRound) {
      return res.json([]);
    }
    const bets = await TeenPattiBet.find({
      userId: req.user.userId,
      roundId: currentRound.roundId,
    }).sort({ createdAt: -1 }).lean();
    res.json(bets);
  } catch (err) {
    console.error('[API TEENPATTI] Get active bets failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch recent historical rounds
router.get('/history', (req, res) => {
  try {
    const detailed = teenPattiManager.getHistory();
    res.json({
      results: detailed.map((h) => h.result),
      rounds: detailed,
    });
  } catch (err) {
    console.error('[API TEENPATTI] Get history failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
