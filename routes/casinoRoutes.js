const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const roundManager = require('../services/roundManager');
const CasinoBet = require('../models/CasinoBet');

// Current Casino state (read-only snapshot; refreshes active viewer TTL if already seated)
router.get('/state', (req, res) => {
  try {
    const state = roundManager.getCurrentState(Date.now());
    res.json(state);
  } catch (err) {
    console.error('[API CASINO] Get state failed:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Explicit Ready-to-Start trigger (starts table cycle when user taps Ready to Start)
router.post('/ready', auth, async (req, res) => {
  try {
    const state = await roundManager.playerReady({ userId: req.user.userId });
    res.json({ success: true, state });
  } catch (err) {
    console.error('[API CASINO] Ready failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to start table' });
  }
});

// Explicit Leave-Table trigger (stops idle ticker when last player leaves)
router.post('/leave', auth, (req, res) => {
  try {
    const state = roundManager.playerLeave({ userId: req.user.userId });
    res.json({ success: true, state });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to leave table' });
  }
});

// Place bet on Player A or Player B
router.post('/bet', auth, async (req, res) => {
  try {
    const { choice, amount } = req.body;
    const result = await roundManager.placeBet(req.user.userId, choice, amount);
    res.json(result);
  } catch (err) {
    console.error('[API CASINO] Bet failed:', err.message);
    res.status(400).json({ error: err.message || 'Bet placement failed' });
  }
});

// User's bets in the current active round (and latest settled round fallback)
router.get('/active-bets', auth, async (req, res) => {
  try {
    const round = roundManager.getCurrentRound();
    if (!round) {
      return res.json([]);
    }
    const bets = await CasinoBet.find({
      userId: req.user.userId,
      roundId: round.roundId,
    }).sort({ createdAt: -1 }).lean();
    res.json(bets);
  } catch (err) {
    console.error('[API CASINO] Active bets failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Recent results bead history
router.get('/history', (req, res) => {
  try {
    const detailed = roundManager.getHistory();
    res.json({
      results: detailed.map((h) => h.result),
      rounds: detailed,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
