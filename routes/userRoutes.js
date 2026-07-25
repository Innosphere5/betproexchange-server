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

const User = require('../models/User');

// Get Account Ledger Endpoint
router.get('/account-ledger', auth, async (req, res) => {
  try {
    const { targetUsername, startDate, endDate, txType = 'credit_cash' } = req.query;
    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    let sDate = startDate ? new Date(startDate) : new Date(new Date().setHours(0, 0, 0, 0));
    let eDate = endDate ? new Date(endDate) : new Date(new Date().setHours(23, 59, 59, 999));

    if (isNaN(sDate.getTime())) sDate = new Date(new Date().setHours(0, 0, 0, 0));
    if (isNaN(eDate.getTime())) eDate = new Date(new Date().setHours(23, 59, 59, 999));

    const FINANCIAL_TYPES = ['LOAD_CREDIT', 'WITHDRAW_CREDIT', 'CREDIT_GIVEN', 'CREDIT_TAKEN', 'LOAD_BALANCE', 'WITHDRAW', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'SETTLEMENT'];

    let typeFilter = {};
    if (txType === 'credit_cash') {
      typeFilter = { type: { $in: FINANCIAL_TYPES } };
    } else if (txType === 'bets') {
      typeFilter = { type: { $nin: FINANCIAL_TYPES } };
    }

    let isAll = (!targetUsername || targetUsername === 'ALL');
    let userFilter = {};

    if (isAll) {
      if (['superadmin', 'admin', 'master'].includes(currentUser.role)) {
        if (currentUser.role === 'superadmin') {
          userFilter = {};
        } else {
          const downlines = await User.find({ parentId: currentUser._id }, 'username');
          const downlineNames = downlines.map(u => u.username);
          downlineNames.push(currentUser.username);
          userFilter = { userId: { $in: downlineNames } };
        }
      } else {
        userFilter = { userId: currentUser.username };
      }
    } else {
      const target = await User.findOne({ username: targetUsername });
      if (!target) return res.status(404).json({ error: 'Target account not found' });

      if (currentUser.role !== 'superadmin') {
        const isChild = await User.findOne({ _id: target._id, parentId: currentUser._id });
        if (!isChild && target.username !== currentUser.username) {
          return res.status(403).json({ error: 'Unauthorized to view this account ledger' });
        }
      }
      userFilter = { userId: target.username };
    }

    // 1. Calculate Opening Balance prior to sDate
    const priorTransactions = await Transaction.find({
      ...userFilter,
      ...typeFilter,
      createdAt: { $lt: sDate }
    }).sort({ createdAt: 1 });

    let openingBalance = 0;
    for (const tx of priorTransactions) {
      openingBalance += (tx.amount || 0);
    }

    // 2. Fetch transactions in range [sDate, eDate]
    const periodTransactions = await Transaction.find({
      ...userFilter,
      ...typeFilter,
      createdAt: { $gte: sDate, $lte: eDate }
    }).sort({ createdAt: 1 });

    const formatLedgerDate = (dateObj) => {
      const d = new Date(dateObj);
      const month = d.getMonth() + 1;
      const day = d.getDate();
      const year = d.getFullYear();
      let hours = d.getHours();
      const minutes = d.getMinutes().toString().padStart(2, '0');
      const seconds = d.getSeconds().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'pm' : 'am';
      hours = hours % 12;
      hours = hours ? hours : 12;
      return `${month}/${day}/${year} ${hours.toString().padStart(2, '0')}:${minutes}:${seconds} ${ampm}`;
    };

    const entries = [];
    entries.push({
      id: 1,
      date: formatLedgerDate(sDate),
      username: isAll ? 'ALL' : (targetUsername || currentUser.username),
      description: 'Opening Balance',
      amount: 0,
      balance: openingBalance,
      performedBy: 'System',
      isOpening: true
    });

    let runningBalance = openingBalance;
    periodTransactions.forEach((tx, idx) => {
      runningBalance += (tx.amount || 0);
      entries.push({
        id: idx + 2,
        date: formatLedgerDate(tx.createdAt),
        username: tx.userId,
        description: tx.description || 'Transaction',
        amount: tx.amount,
        balance: runningBalance,
        performedBy: tx.performedBy || tx.userId,
        type: tx.type,
        category: tx.category
      });
    });

    res.json({
      success: true,
      username: isAll ? 'ALL' : (targetUsername || currentUser.username),
      role: currentUser.role,
      startDate: sDate,
      endDate: eDate,
      txType,
      openingBalance,
      closingBalance: runningBalance,
      entries
    });
  } catch (err) {
    console.error("Account Ledger Error:", err);
    res.status(500).json({ error: 'Failed to fetch account ledger' });
  }
});

// Downline List for Account Selector dropdown
router.get('/downline-list', auth, async (req, res) => {
  try {
    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    let downlines = [];
    if (currentUser.role === 'superadmin') {
      downlines = await User.find({}, 'username role walletBalance credit').sort({ username: 1 });
    } else {
      downlines = await User.find({ parentId: currentUser._id }, 'username role walletBalance credit').sort({ username: 1 });
      downlines.unshift({ _id: currentUser._id, username: currentUser.username, role: currentUser.role });
    }

    res.json({ success: true, users: downlines });
  } catch (err) {
    console.error("Downline list error:", err);
    res.status(500).json({ error: 'Failed to fetch downlines' });
  }
});

module.exports = router;
