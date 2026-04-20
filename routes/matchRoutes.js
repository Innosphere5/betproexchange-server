const express = require('express');
const router = express.Router();
const Match = require('../models/Match');

// Get only live matches
router.get('/live', async (req, res) => {
    try {
        const liveMatches = await Match.find({ status: 'live' }).sort({ startTime: -1 });
        res.json(liveMatches);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get all matches
router.get('/', async (req, res) => {
    try {
        const matches = await Match.find().sort({ startTime: 1 });
        res.json(matches);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// Get match by ID
router.get('/:id', async (req, res) => {
    try {
        const match = await Match.findOne({ matchId: req.params.id });
        if (!match) return res.status(404).json({ message: 'Match not found' });
        res.json(match);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
