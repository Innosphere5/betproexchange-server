const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const auth = require('../middleware/auth');

// Middleware to check if user is Admin or Master
const isAdminOrMaster = (req, res, next) => {
  if (req.user.role === 'admin' || req.user.role === 'master') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Requires Admin or Master role.' });
  }
};

// Create Downline User (Bettor or Master)
router.post('/create-user', auth, isAdminOrMaster, async (req, res) => {
  try {
    const { username, password, role, initialBalance } = req.body;

    // Validation
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Role restriction: Master can only create 'user' (Bettor)
    if (req.user.role === 'master' && role !== 'user') {
      return res.status(403).json({ error: 'Masters can only create Bettors' });
    }

    let existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: 'Username already exists' });

    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'Parent user not found' });

    // Initial Balance Check
    const balance = parseFloat(initialBalance) || 0;
    if (req.user.role !== 'admin' && parent.walletBalance < balance) {
      return res.status(400).json({ error: 'Insufficient balance in parent account' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      username,
      password: hashedPassword,
      role,
      parentId: parent._id,
      walletBalance: balance
    });

    // Deduct from parent balance if not Admin
    if (req.user.role !== 'admin') {
      parent.walletBalance -= balance;
      await parent.save();
    }

    await newUser.save();
    res.json({ success: true, user: { username: newUser.username, role: newUser.role, balance: newUser.walletBalance } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Downline Users
router.get('/downline', auth, isAdminOrMaster, async (req, res) => {
  try {
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    let query = { parentId: parent._id };
    // If Admin, maybe show all? But request says "connect pipelines", so usually hierarchy.
    // For now, only direct downline.
    const users = await User.find(query).select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Load Balance
router.post('/load-balance', auth, isAdminOrMaster, async (req, res) => {
  try {
    const { targetUsername, amount } = req.body;
    const addAmount = parseFloat(amount);

    if (isNaN(addAmount) || addAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const parent = await User.findOne({ username: req.user.userId });
    const target = await User.findOne({ username: targetUsername, parentId: parent._id });

    if (!target) return res.status(404).json({ error: 'Downline user not found' });

    // Restriction: Master can only load balance for Bettors (role: 'user')
    if (req.user.role === 'master' && target.role !== 'user') {
      return res.status(403).json({ error: 'Masters can only load balance for Bettors' });
    }

    // Deduct from parent if not Admin
    if (req.user.role !== 'admin') {
      if (parent.walletBalance < addAmount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      parent.walletBalance -= addAmount;
      await parent.save();
    }

    target.walletBalance += addAmount;
    await target.save();

    // Create Transaction Record
    const newTransaction = new Transaction({
      userId: target.username,
      amount: addAmount,
      type: 'LOAD_BALANCE',
      description: `Balance loaded by ${parent.role} ${parent.username}`,
      performedBy: parent.username
    });
    await newTransaction.save();

    res.json({ success: true, newBalance: target.walletBalance, parentBalance: parent.walletBalance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Downline User Statement (Ledger)
router.get('/user-statement/:username', auth, isAdminOrMaster, async (req, res) => {
  try {
    const { username } = req.params;
    const parent = await User.findOne({ username: req.user.userId });
    
    // Ensure the target is in the downline
    const target = await User.findOne({ username, parentId: parent._id });
    if (!target) return res.status(403).json({ error: 'Access denied: User not in downline' });

    const transactions = await Transaction.find({ userId: username }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
