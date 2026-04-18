const express = require('express');
const router = express.Router();
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const auth = require('../middleware/auth');

// Get User Statement (All transactions/bets)
router.get('/statement', auth, async (req, res) => {
  try {
    const cricketBets = await Bet.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    const casinoBets = await CasinoBet.find({ userId: req.user.userId }).sort({ createdAt: -1 });

    // Combine and format for statement
    const statement = [
      ...cricketBets.map(b => ({
        id: b._id,
        date: b.createdAt,
        description: `Bet on ${b.matchName} (${b.runner})`,
        amount: -b.stake,
        type: 'CRICKET_BET',
        status: b.status
      })),
      ...casinoBets.map(b => ({
        id: b._id,
        date: b.createdAt,
        description: `Casino Bet (Choice: ${b.choice})`,
        amount: -b.amount,
        type: 'CASINO_BET',
        status: b.status
      }))
    ];

    // Add winning entries if settled
    cricketBets.filter(b => b.status === 'WIN').forEach(b => {
        statement.push({
            id: `WIN-${b._id}`,
            date: b.updatedAt || b.createdAt,
            description: `Win Payout: ${b.matchName}`,
            amount: b.stake * b.odds,
            type: 'CRICKET_WIN',
            status: 'SETTLED'
        });
    });

    casinoBets.filter(b => b.status === 'WIN').forEach(b => {
        statement.push({
            id: `WIN-${b._id}`,
            date: b.updatedAt || b.createdAt,
            description: `Casino Win Payout`,
            amount: b.amount * (b.odds || 2.0),
            type: 'CASINO_WIN',
            status: 'SETTLED'
        });
    });

    statement.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(statement);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get User Results (Only settled bets)
router.get('/results', auth, async (req, res) => {
  try {
    const cricketBets = await Bet.find({ userId: req.user.userId, status: { $in: ['WIN', 'LOSE'] } }).sort({ createdAt: -1 });
    const casinoBets = await CasinoBet.find({ userId: req.user.userId, status: { $in: ['WIN', 'LOSE'] } }).sort({ createdAt: -1 });

    res.json({ cricket: cricketBets, casino: casinoBets });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get User Profit & Loss
router.get('/profit-loss', auth, async (req, res) => {
  try {
    const cricketBets = await Bet.find({ userId: req.user.userId, status: { $in: ['WIN', 'LOSE'] } });
    const casinoBets = await CasinoBet.find({ userId: req.user.userId, status: { $in: ['WIN', 'LOSE'] } });

    let cricketPL = 0;
    cricketBets.forEach(b => {
        if (b.status === 'WIN') cricketPL += (b.stake * (b.odds - 1));
        else if (b.status === 'LOSE') cricketPL -= b.stake;
    });

    let casinoPL = 0;
    casinoBets.forEach(b => {
        if (b.status === 'WIN') casinoPL += (b.amount * ((b.odds || 2.0) - 1));
        else if (b.status === 'LOSE') casinoPL -= b.amount;
    });

    res.json({
        totalPL: cricketPL + casinoPL,
        cricketPL,
        casinoPL,
        details: {
            cricketCount: cricketBets.length,
            casinoCount: casinoBets.length
        }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get User Bets (Active & Settled)
router.get('/bets', auth, async (req, res) => {
  try {
    const cricketBets = await Bet.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    const casinoBets = await CasinoBet.find({ userId: req.user.userId }).sort({ createdAt: -1 });

    const combinedBets = [
        ...cricketBets.map(b => ({
            ...b.toObject(),
            sport: 'Cricket',
            event: b.matchName,
            selection: b.runner,
            placed: b.createdAt,
            updated: b.updatedAt || b.createdAt
        })),
        ...casinoBets.map(b => ({
            ...b.toObject(),
            sport: 'Casino',
            event: `Casino Round ${b.roundId}`,
            selection: b.choice,
            stake: b.amount,
            placed: b.createdAt,
            updated: b.createdAt // Casino bets are usually settled instantly or per round
        }))
    ];

    combinedBets.sort((a, b) => new Date(b.placed) - new Date(a.placed));
    res.json(combinedBets);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
