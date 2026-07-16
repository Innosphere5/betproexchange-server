const express = require('express');
const router = express.Router();
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const AviatorBet = require('../models/AviatorBet');
const Transaction = require('../models/Transaction');
const auth = require('../middleware/auth');

// Get User Statement (All transactions/bets)
router.get('/statement', auth, async (req, res) => {
  try {
    const cricketBets = await Bet.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    const casinoBets = await CasinoBet.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    const aviatorBets = await AviatorBet.find({ userId: req.user.userId }).sort({ createdAt: -1 });

    const transactions = await Transaction.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    
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
      })),
      ...aviatorBets.map(b => ({
        id: b._id,
        date: b.createdAt,
        description: `Aviator Bet (Slot: ${b.betSlot})`,
        amount: -b.stake,
        type: 'AVIATOR_BET',
        status: b.status
      })),
      ...transactions.map(t => ({
        id: t._id,
        date: t.createdAt,
        description: t.description || 'Balance Transaction',
        amount: t.amount,
        type: t.type,
        status: 'SETTLED'
      }))
    ];

    // Add winning entries if settled
    cricketBets.filter(b => b.status === 'won' || b.status === 'WIN').forEach(b => {
        statement.push({
            id: `WIN-${b._id}`,
            date: b.updatedAt || b.createdAt,
            description: `Win Payout: ${b.matchName}`,
            amount: b.payout || (b.stake * b.odds),
            type: 'CRICKET_WIN',
            status: 'SETTLED'
        });
    });

    casinoBets.filter(b => b.status === 'WIN').forEach(b => {
        const profit = b.amount * ((b.odds || 2.0) - 1);
        const netProfit = profit * 0.95;
        const netPayout = b.amount + netProfit;
        statement.push({
            id: `WIN-${b._id}`,
            date: b.updatedAt || b.createdAt,
            description: `Casino Win Payout`,
            amount: netPayout,
            type: 'CASINO_WIN',
            status: 'SETTLED'
        });
    });

    aviatorBets.filter(b => b.status === 'WON').forEach(b => {
        statement.push({
            id: `WIN-${b._id}`,
            date: b.cashoutTime || b.createdAt,
            description: `Aviator Win Payout (${b.cashoutMultiplier}x)`,
            amount: b.payout,
            type: 'AVIATOR_WIN',
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
    const cricketBets = await Bet.find({ userId: req.user.userId, status: { $in: ['won', 'lost', 'WIN', 'LOSE'] } }).sort({ createdAt: -1 });
    const casinoBets = await CasinoBet.find({ userId: req.user.userId, status: { $in: ['won', 'lost', 'WIN', 'LOSE'] } }).sort({ createdAt: -1 });
    const aviatorBets = await AviatorBet.find({ userId: req.user.userId, status: { $in: ['WON', 'LOST'] } }).sort({ createdAt: -1 });

    res.json({ cricket: cricketBets, casino: casinoBets, aviator: aviatorBets });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get User Profit & Loss
router.get('/profit-loss', auth, async (req, res) => {
  try {
    const cricketBets = await Bet.find({ userId: req.user.userId, status: { $in: ['WIN', 'LOSE'] } });
    const casinoBets = await CasinoBet.find({ userId: req.user.userId, status: { $in: ['WIN', 'LOSE'] } });
    const aviatorBets = await AviatorBet.find({ userId: req.user.userId, status: { $in: ['WON', 'LOST'] } });

    let cricketPL = 0;
    cricketBets.forEach(b => {
        if (b.status === 'won' || b.status === 'WIN') cricketPL += ((b.payout || (b.stake * b.odds)) - b.stake);
        else if (b.status === 'lost' || b.status === 'LOSE') cricketPL -= b.stake;
    });

    let casinoPL = 0;
    casinoBets.forEach(b => {
        if (b.status === 'WIN') {
            const profit = b.amount * ((b.odds || 2.0) - 1);
            const netProfit = profit * 0.95;
            casinoPL += netProfit;
        } else if (b.status === 'LOSE') {
            casinoPL -= b.amount;
        }
    });

    let aviatorPL = 0;
    aviatorBets.forEach(b => {
        if (b.status === 'WON') {
            aviatorPL += (b.payout - b.stake);
        } else if (b.status === 'LOST') {
            aviatorPL -= b.stake;
        }
    });

    res.json({
        totalPL: cricketPL + casinoPL + aviatorPL,
        cricketPL,
        casinoPL,
        aviatorPL,
        details: {
            cricketCount: cricketBets.length,
            casinoCount: casinoBets.length,
            aviatorCount: aviatorBets.length
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
    const aviatorBets = await AviatorBet.find({ userId: req.user.userId }).sort({ createdAt: -1 });

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
        })),
        ...aviatorBets.map(b => ({
            ...b.toObject(),
            sport: 'Aviator',
            event: `Aviator Round ${b.roundId}`,
            selection: `Slot ${b.betSlot} (Cashed: ${b.cashoutMultiplier ? b.cashoutMultiplier + 'x' : 'N/A'})`,
            stake: b.stake,
            placed: b.createdAt,
            updated: b.cashoutTime || b.createdAt
        }))
    ];

    combinedBets.sort((a, b) => new Date(b.placed) - new Date(a.placed));
    res.json(combinedBets);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
