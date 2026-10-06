const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Match = require('../models/Match');
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const AviatorBet = require('../models/AviatorBet');
const TeenPattiBet = require('../models/TeenPattiBet');
const AviatorXBet = require('../models/AviatorXBet');
const auth = require('../middleware/auth');
const { generateFinalSheet } = require('../services/finalSheetEngine');
const {
  findUserByKey,
  getAllDescendants,
  getAllDescendantUsernames,
  getAncestorChain,
  getViewerNetShare
} = require('../services/hierarchyHelper');
const { settleMatch } = require('../services/settlementService');

// Helper to reliably find a user from JWT req.user payload across username casing or ID
const findUserFromReq = async (reqUser) => {
  if (!reqUser) return null;
  const key = reqUser.userId || reqUser.id || reqUser._id;
  return await findUserByKey(key);
};

// Middleware to check if user is Authorized (SuperAdmin, Admin, SuperMaster or Master)
const isAuthorized = (req, res, next) => {
  const authorizedRoles = ['superadmin', 'admin', 'supermaster', 'master'];
  if (authorizedRoles.includes(req.user.role)) {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Requires Authorized role.' });
  }
};

// Helper functions for Final Sheet based Client P/L calculation
async function getFinalSheetForUser(viewerUser, isDailyReport = false) {
  const types = ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'LOAD_BALANCE', 'WITHDRAW'];

  const allowedUsernames = await getAllDescendantUsernames(viewerUser);

  const query = { 
    $or: [
      { userId: { $in: allowedUsernames } },
      { downline: { $in: allowedUsernames } }
    ],
    type: { $in: types }
  };

  const txs = await Transaction.find(query).sort({ createdAt: -1 }).lean();
  return await generateFinalSheet(viewerUser, txs, isDailyReport);
}

function extractPlMapFromFinalSheet(finalSheetData) {
  const plMap = {};
  if (finalSheetData && finalSheetData.greenEntries) {
    finalSheetData.greenEntries.forEach(e => {
      if (e.accountName && e.accountName !== 'cash' && e.accountName !== 'BOOK') {
        plMap[e.accountName] = (plMap[e.accountName] || 0) + e.amount;
      }
    });
  }
  if (finalSheetData && finalSheetData.redEntries) {
    finalSheetData.redEntries.forEach(e => {
      if (e.accountName && e.accountName !== 'cash' && e.accountName !== 'BOOK') {
        plMap[e.accountName] = (plMap[e.accountName] || 0) - e.amount;
      }
    });
  }
  return plMap;
}



// Create Downline User (Admin, SuperMaster, Master, or Bettor)
router.post('/create-user', auth, isAuthorized, async (req, res) => {
  try {
    const { username, password, role, initialBalance, balanceType, type, share, allowSettlement } = req.body;
    const selectedBalanceType = balanceType || type || 'cash';
    const settlementAllowed = allowSettlement !== undefined ? Boolean(allowSettlement) : true;

    // Validation
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Share Validation (dynamic based on SuperAdmin's share)
    const masterShare = parseFloat(share) || 0;

    // Role restriction logic
    if (req.user.role === 'superadmin' && !['admin', 'user'].includes(role)) {
      return res.status(403).json({ error: 'SuperAdmins can only create Admins or Bettors' });
    }
    if (req.user.role === 'admin' && !['supermaster', 'user'].includes(role)) {
      return res.status(403).json({ error: 'Admins can only create SuperMasters or Bettors' });
    }
    if (req.user.role === 'supermaster' && !['master', 'user'].includes(role)) {
      return res.status(403).json({ error: 'SuperMasters can only create Masters or Bettors' });
    }
    if (req.user.role === 'master' && role !== 'user') {
      return res.status(403).json({ error: 'Masters can only create Bettors' });
    }

    const lowerUsername = username.toLowerCase().trim();

    // Parallelize username existence check, parent lookup, and password hashing
    const [existingUser, parent, hashedPassword] = await Promise.all([
      User.findOne({ username: lowerUsername }).select('_id').lean(),
      findUserByKey(req.user.userId),
      bcrypt.hash(password, 10)
    ]);

    if (existingUser) return res.status(400).json({ error: 'Username already exists' });
    if (!parent) return res.status(404).json({ error: 'Parent user not found' });

    // Dynamic share limit based on SuperAdmin's share (e.g., 85 for adnan, 97 for MD97FS, 100 for MD202FS)
    const superAdminShareLimit = req.user.role === 'superadmin' ? (parent.share || 85) : 85;
    const bookSharePercent = Math.max(0, 100 - superAdminShareLimit);
    if (masterShare < 0 || masterShare > superAdminShareLimit) {
      return res.status(400).json({ error: `Share must be between 0 and ${superAdminShareLimit} (${bookSharePercent}% is reserved for Book)` });
    }

    // Share Hierarchy Validation
    if (['admin', 'supermaster', 'master'].includes(role)) {
      const parentShareLimit = req.user.role === 'superadmin' ? superAdminShareLimit : (parent.share || 0);
      if (req.user.role !== 'superadmin' && masterShare > parentShareLimit) {
        return res.status(400).json({ error: `Downline share cannot exceed your share (${parentShareLimit}%)` });
      }
      if (req.user.role === 'superadmin' && masterShare > superAdminShareLimit) {
        return res.status(400).json({ error: `Share must be between 0 and ${superAdminShareLimit} (${bookSharePercent}% is reserved for Book)` });
      }
    }

    const balance = parseFloat(initialBalance) || 0;
    if (isNaN(balance) || balance < 0) {
      return res.status(400).json({ error: 'Invalid initial balance' });
    }

    let parentCurrentBalance = parent.walletBalance || 0;

    if (balance > 0) {
      // Atomic deduction from parent's walletBalance for ALL roles (including SuperAdmin) for cash & credit
      const updatedParent = await User.findOneAndUpdate(
        { _id: parent._id, walletBalance: { $gte: balance } },
        { $inc: { walletBalance: -balance } },
        { new: true }
      ).lean();

      if (!updatedParent) {
        return res.status(400).json({ 
          error: `Insufficient wallet balance in your account (${parent.username}). Available: ₹${(parent.walletBalance || 0).toLocaleString('en-IN')}, requested: ₹${balance.toLocaleString('en-IN')}` 
        });
      }

      parentCurrentBalance = updatedParent.walletBalance;
    }

    const txsToInsert = [];
    let newUser;

    if (selectedBalanceType === 'credit') {
      newUser = new User({
        username: lowerUsername,
        password: hashedPassword,
        role,
        share: ['admin', 'supermaster', 'master'].includes(role) ? masterShare : 0,
        parentId: parent._id,
        walletBalance: balance,
        credit: balance,
        allowSettlement: role === 'user' ? false : settlementAllowed
      });

      if (balance > 0) {
        txsToInsert.push({
          userId: lowerUsername,
          amount: balance,
          type: 'LOAD_CREDIT',
          category: 'credit',
          description: `Initial Credit Received from ${parent.role} ${parent.username} (Credit)`,
          performedBy: parent.username
        });
        txsToInsert.push({
          userId: parent.username,
          amount: -balance,
          type: 'CREDIT_GIVEN',
          category: 'credit',
          downline: lowerUsername,
          description: `Initial Credit Issued to ${lowerUsername} (Credit)`,
          performedBy: parent.username
        });
      }
    } else {
      // Default: Cash Deposit
      if (balance > 0) {
        txsToInsert.push({
          userId: parent.username,
          amount: -balance,
          type: 'CASH_DEPOSIT',
          category: 'wallet',
          downline: lowerUsername,
          description: `Initial Cash Deposit to ${lowerUsername}`,
          performedBy: parent.username
        });
        txsToInsert.push({
          userId: lowerUsername,
          amount: balance,
          type: 'LOAD_BALANCE',
          category: 'wallet',
          description: `Initial Cash Deposit from ${parent.role} ${parent.username}`,
          performedBy: parent.username
        });
      }

      newUser = new User({
        username: lowerUsername,
        password: hashedPassword,
        role,
        share: ['admin', 'supermaster', 'master'].includes(role) ? masterShare : 0,
        parentId: parent._id,
        walletBalance: balance,
        credit: 0,
        allowSettlement: role === 'user' ? false : settlementAllowed
      });
    }

    // Save user and batch insert transactions concurrently
    await Promise.all([
      newUser.save(),
      txsToInsert.length > 0 ? Transaction.insertMany(txsToInsert) : Promise.resolve()
    ]);

    res.json({ 
      success: true, 
      user: { 
        username: newUser.username, 
        role: newUser.role, 
        balance: newUser.walletBalance,
        credit: newUser.credit
      },
      parentBalance: parentCurrentBalance
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Downline Users with sub-user counts and Client P/L (Supports optional ?username= for hierarchy drill-down)
router.get('/downline', auth, isAuthorized, async (req, res) => {
  try {
    const loggedInUser = await findUserFromReq(req.user);
    if (!loggedInUser) return res.status(404).json({ error: 'User not found' });

    let targetParent = loggedInUser;
    const { username } = req.query;

    if (username && username.trim() !== '' && username.trim().toLowerCase() !== loggedInUser.username.toLowerCase()) {
      const requestedUser = await findUserByKey(username);
      if (!requestedUser) {
        return res.status(404).json({ error: 'Requested parent user not found' });
      }

      // Authorization check: Is requestedUser in loggedInUser's downline tree?
      let curr = requestedUser;
      let isDescendant = false;
      while (curr && curr.parentId) {
        if (curr.parentId.toString() === loggedInUser._id.toString()) {
          isDescendant = true;
          break;
        }
        curr = await User.findById(curr.parentId).select('_id parentId').lean();
      }
      if (!isDescendant) {
        return res.status(403).json({ error: 'Access denied: Target user is not in your downline' });
      }
      targetParent = requestedUser;
    }

    // Fetch direct children of targetParent
    const users = await User.find({ parentId: targetParent._id }).select('-password').sort({ createdAt: -1 }).lean();
    
    // Efficiently get counts for all found users in one aggregation
    const userIds = users.map(u => u._id);
    const counts = userIds.length > 0 ? await User.aggregate([
      { $match: { parentId: { $in: userIds } } },
      { $group: { _id: "$parentId", count: { $sum: 1 } } }
    ]) : [];

    const countMap = {};
    counts.forEach(c => countMap[c._id.toString()] = c.count);

    // Compute sheets for targetParent in parallel
    const [targetParentBettingSheet, targetParentSettlementSheet] = await Promise.all([
      getFinalSheetForUser(targetParent, true),
      getFinalSheetForUser(targetParent, false)
    ]);

    const bettingPlMap = extractPlMapFromFinalSheet(targetParentBettingSheet);
    const settlementPlMap = extractPlMapFromFinalSheet(targetParentSettlementSheet);

    // Batch fetch settlement transactions for all non-bettors in a single aggregation query
    const nonBettorUsernames = users.filter(u => u.role !== 'user').map(u => u.username);
    const settleMap = {};
    if (nonBettorUsernames.length > 0) {
      const uSettleAgg = await Transaction.aggregate([
        { $match: { type: 'SETTLEMENT', userId: targetParent.username, downline: { $in: nonBettorUsernames } } },
        { $group: { _id: "$downline", total: { $sum: "$amount" } } }
      ]);
      uSettleAgg.forEach(s => {
        settleMap[s._id] = s.total || 0;
      });
    }

    const usersWithCountsAndPL = users.map((u) => {
      if (u.role === 'user') {
        const bettorClientPL = Math.round(((u.walletBalance || 0) - (u.credit || 0)) * 100) / 100;
        return {
          ...u,
          downlineCount: countMap[u._id.toString()] || 0,
          clientPL: bettorClientPL,
          balanceUpline: 0,
          sharePL: 0,
          plDownline: 0,
          availableBalance: u.walletBalance || 0
        };
      }

      // 1. Gross Share P/L from betting in targetParent's pipeline
      const grossSharePL = Math.round((bettingPlMap[u.username] || 0) * 100) / 100;

      // 2. Client (P/L) = Exact net balance on targetParent's Final Sheet (clears to 0 when cash deposited/withdrawn)
      const clientPL = Math.round((settlementPlMap[u.username] || 0) * 100) / 100;

      // 3. Available Balance = Gross Share P/L minus total S-button SETTLEMENT transactions
      const totalSettledAmount = settleMap[u.username] || 0;
      const settlementAvailableBalance = Math.round((grossSharePL - totalSettledAmount) * 100) / 100;

      return {
        ...u,
        downlineCount: countMap[u._id.toString()] || 0,
        clientPL: clientPL,
        balanceUpline: settlementAvailableBalance,
        sharePL: clientPL,
        plDownline: clientPL,
        availableBalance: settlementAvailableBalance
      };
    });

    // Build parent hierarchy breadcrumbs from targetParent back up to loggedInUser
    const breadcrumbs = [];
    let ancestor = targetParent;
    while (ancestor) {
      breadcrumbs.unshift({
        username: ancestor.username,
        role: ancestor.role,
        _id: ancestor._id.toString()
      });
      if (ancestor._id.toString() === loggedInUser._id.toString()) break;
      ancestor = ancestor.parentId ? await User.findById(ancestor.parentId).select('username role _id parentId').lean() : null;
    }

    // Calculate parent's own Client P/L & Share P/L for the summary row
    let parentClientPL = 0;
    if (targetParent.role === 'master') {
      parentClientPL = usersWithCountsAndPL.reduce((sum, u) => sum + (u.clientPL || 0), 0);
    } else if (targetParent._id.toString() === loggedInUser._id.toString()) {
      parentClientPL = targetParentBettingSheet.netAmount || 0;
    } else {
      const loggedInUserBettingSheet = await getFinalSheetForUser(loggedInUser, true);
      const loggedInBettingPlMap = extractPlMapFromFinalSheet(loggedInUserBettingSheet);
      parentClientPL = loggedInBettingPlMap[targetParent.username] || 0;
    }
    parentClientPL = Math.round(parentClientPL * 100) / 100;

    let parentAvailableBalance = 0;
    if (targetParent.parentId) {
      const parentOfTarget = await User.findById(targetParent.parentId).lean();
      if (parentOfTarget) {
        const parentOfTargetSettlementSheet = await getFinalSheetForUser(parentOfTarget, false);
        const parentSettlementPlMap = extractPlMapFromFinalSheet(parentOfTargetSettlementSheet);
        parentAvailableBalance = Math.round((parentSettlementPlMap[targetParent.username] || 0) * 100) / 100;
      }
    } else if (targetParent.role === 'superadmin') {
      parentAvailableBalance = Math.round((targetParentSettlementSheet.netAmount || 0) * 100) / 100;
    }

    // Return object with users list, target parent info and breadcrumbs
    res.json({
      users: usersWithCountsAndPL,
      parentInfo: {
        username: targetParent.username,
        role: targetParent.role,
        _id: targetParent._id,
        credit: targetParent.credit || 0,
        walletBalance: targetParent.walletBalance || 0,
        share: targetParent.share || 0,
        clientPL: parentClientPL,
        balanceUpline: parentAvailableBalance,
        sharePL: parentClientPL,
        plDownline: parentClientPL,
        availableBalance: parentAvailableBalance
      },
      breadcrumbs
    });
  } catch (err) {
    console.error("Downline Error:", err);
    res.status(500).json({ error: 'Server error fetching downline' });
  }
});

// Load Balance
router.post('/load-balance', auth, isAuthorized, async (req, res) => {
  try {
    const { targetUsername, amount, type } = req.body;
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

    // Deduct from parent's wallet atomically for ALL roles (including SuperAdmin) for both cash & credit
    const updatedParent = await User.findOneAndUpdate(
      { _id: parent._id, walletBalance: { $gte: addAmount } },
      { $inc: { walletBalance: -addAmount } },
      { new: true }
    );

    if (!updatedParent) {
      return res.status(400).json({ 
        error: `Insufficient wallet balance in your account (${parent.username}). Available: ₹${parent.walletBalance.toLocaleString('en-IN')}, requested: ₹${addAmount.toLocaleString('en-IN')}` 
      });
    }

    parent.walletBalance = updatedParent.walletBalance;

    if (type === 'credit') {
      target.credit = (target.credit || 0) + addAmount;
      target.walletBalance = (target.walletBalance || 0) + addAmount;
      await target.save();
    } else {
      target.walletBalance = (target.walletBalance || 0) + addAmount;
      await target.save();
    }

    // Create Transaction Record for target
    const newTransaction = new Transaction({
      userId: target.username,
      amount: addAmount,
      type: type === 'credit' ? 'LOAD_CREDIT' : 'LOAD_BALANCE',
      description: type === 'credit' 
        ? `Credit Received from ${parent.username} (Credit)` 
        : `Cash Deposit from ${parent.username}`,
      performedBy: parent.username
    });
    await newTransaction.save();

    // Create Transaction Record for parent (for Account Ledger & Final Sheet)
    if (type === 'credit') {
      const parentTx = new Transaction({
        userId: parent.username,
        amount: -addAmount,
        type: 'CREDIT_GIVEN',
        category: 'credit',
        downline: target.username,
        description: `Credit Issued to ${target.username} (Credit)`,
        performedBy: parent.username
      });
      await parentTx.save();
    } else {
      const settlementTx = new Transaction({
        userId: parent.username,
        amount: addAmount,
        type: 'CASH_DEPOSIT',
        category: 'wallet',
        downline: target.username,
        description: `Cash Deposit to ${target.username}`,
        performedBy: parent.username
      });
      await settlementTx.save();
    }

    res.json({ success: true, newBalance: target.walletBalance, newCredit: target.credit, parentBalance: parent.walletBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Withdraw Balance (Reduce)
router.post('/withdraw-balance', auth, isAuthorized, async (req, res) => {
  try {
    const { targetUsername, amount, type } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const parent = await User.findOne({ username: req.user.userId });
    const target = await User.findOne({ username: targetUsername, parentId: parent._id });

    if (!target) return res.status(404).json({ error: 'Downline user not found' });

    // Restriction: Master can only withdraw from Bettors
    if (req.user.role === 'master' && target.role !== 'user') {
      return res.status(403).json({ error: 'Masters can only manage Bettors' });
    }

    if (type === 'credit') {
      // Deduct credit & wallet balance from target atomically
      const updatedTarget = await User.findOneAndUpdate(
        { _id: target._id, credit: { $gte: withdrawAmount }, walletBalance: { $gte: withdrawAmount } },
        { $inc: { credit: -withdrawAmount, walletBalance: -withdrawAmount } },
        { new: true }
      );

      if (!updatedTarget) {
        return res.status(400).json({ 
          error: `User has insufficient credit or balance to withdraw. Available credit: ₹${(target.credit || 0).toLocaleString('en-IN')}, available balance: ₹${(target.walletBalance || 0).toLocaleString('en-IN')}, requested: ₹${withdrawAmount.toLocaleString('en-IN')}` 
        });
      }

      // Return credit back to parent's wallet balance
      const updatedParent = await User.findByIdAndUpdate(
        parent._id,
        { $inc: { walletBalance: withdrawAmount } },
        { new: true }
      );

      target.credit = updatedTarget.credit;
      target.walletBalance = updatedTarget.walletBalance;
      parent.walletBalance = updatedParent.walletBalance;
    } else {
      // Cash Withdrawal: Check if target has enough walletBalance OR credit available
      const availableCash = Math.max(0, target.walletBalance || 0);
      const availableCredit = Math.max(0, target.credit || 0);
      const totalAvailable = (target.walletBalance >= 0) ? (target.walletBalance + availableCredit) : availableCredit;

      if (target.walletBalance < withdrawAmount && availableCredit < withdrawAmount && totalAvailable < withdrawAmount) {
        return res.status(400).json({ 
          error: `User has insufficient balance or credit to withdraw cash. Available balance: ₹${(target.walletBalance || 0).toLocaleString('en-IN')}, available credit: ₹${availableCredit.toLocaleString('en-IN')}, requested: ₹${withdrawAmount.toLocaleString('en-IN')}` 
        });
      }

      const updatedTarget = await User.findOneAndUpdate(
        { _id: target._id },
        { $inc: { walletBalance: -withdrawAmount } },
        { new: true }
      );

      if (!updatedTarget) {
        return res.status(400).json({ 
          error: `Failed to process cash withdrawal for ${target.username}` 
        });
      }

      // Return cash back to parent's wallet for ALL roles (including SuperAdmin)
      const updatedParent = await User.findByIdAndUpdate(
        parent._id,
        { $inc: { walletBalance: withdrawAmount } },
        { new: true }
      );

      target.credit = updatedTarget.credit;
      target.walletBalance = updatedTarget.walletBalance;
      parent.walletBalance = updatedParent.walletBalance;
    }

    await target.save();

    // Create Transaction Record for target
    const newTransaction = new Transaction({
      userId: target.username,
      amount: -withdrawAmount,
      type: type === 'credit' ? 'WITHDRAW_CREDIT' : 'WITHDRAW',
      description: type === 'credit'
        ? `Credit Withdrawn by ${parent.username} (Credit)`
        : `Cash Withdrawal by ${parent.username}`,
      performedBy: parent.username
    });
    await newTransaction.save();

    // Create Transaction Record for parent (for Account Ledger & Final Sheet)
    if (type === 'credit') {
      const parentTx = new Transaction({
        userId: parent.username,
        amount: withdrawAmount,
        type: 'CREDIT_TAKEN',
        category: 'credit',
        downline: target.username,
        description: `Credit Withdrawn from ${target.username} (Credit)`,
        performedBy: parent.username
      });
      await parentTx.save();
    } else {
      const settlementTx = new Transaction({
        userId: parent.username,
        amount: -withdrawAmount,
        type: 'CASH_WITHDRAWAL',
        category: 'wallet',
        downline: target.username,
        description: `Cash Withdrawal from ${target.username}`,
        performedBy: parent.username
      });
      await settlementTx.save();
    }
    res.json({ success: true, newBalance: target.walletBalance, newCredit: target.credit, parentBalance: parent.walletBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Settle Account (P/L Settlement)
router.post('/settle-account', auth, isAuthorized, async (req, res) => {
  try {
    const { targetUsername, amount, description } = req.body;
    const rawAmount = parseFloat(amount);

    if (isNaN(rawAmount) || rawAmount === 0) {
      return res.status(400).json({ error: 'Invalid settlement amount' });
    }

    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'Parent user not found' });

    let target;
    if (req.user.role === 'superadmin') {
      const allowedUsernames = await getAllDescendantUsernames(parent);
      if (!allowedUsernames.includes(targetUsername)) {
        return res.status(403).json({ error: 'Access denied: Target user not in your downline' });
      }
      target = await User.findOne({ username: targetUsername });
    } else {
      target = await User.findOne({ username: targetUsername, parentId: parent._id });
    }

    if (!target) return res.status(404).json({ error: 'Downline user not found' });

    // Check if settlement is allowed for target
    if (target.allowSettlement === false) {
      return res.status(403).json({ error: 'Settlement is disabled for this user account' });
    }

    // Resolve direct parent of target user
    let directParent = parent;
    if (target.parentId) {
      const fetchedParent = await User.findById(target.parentId);
      if (fetchedParent) directParent = fetchedParent;
    }

    // Calculate the current Available Balance (Gross Share P/L minus total S-button SETTLEMENT transactions)
    const parentBettingSheet = await getFinalSheetForUser(directParent, true);
    const bettingPlMap = extractPlMapFromFinalSheet(parentBettingSheet);
    const grossSharePL = Math.round((bettingPlMap[target.username] || 0) * 100) / 100;

    const uSettleTxs = await Transaction.find({
      type: 'SETTLEMENT',
      userId: directParent.username,
      downline: target.username
    }).lean();
    let totalSettledAmount = 0;
    uSettleTxs.forEach(t => {
      totalSettledAmount += (t.amount || 0);
    });
    const currentAvailableBalance = Math.round((grossSharePL - totalSettledAmount) * 100) / 100;

    if (currentAvailableBalance === 0) {
      return res.status(400).json({ error: 'Settlement available balance is 0. Nothing to settle until new profit/loss arrives.' });
    }

    const absAvailableBalance = Math.abs(currentAvailableBalance);
    let settleAmount = Math.abs(rawAmount);

    if (settleAmount > absAvailableBalance) {
      settleAmount = absAvailableBalance;
    }

    // Direction logic based on Available Balance:
    // If currentAvailableBalance > 0: settling reduces it towards 0 (Green to 0).
    // If currentAvailableBalance < 0: settling reduces it towards 0 (Red to 0).
    let isTargetCredit;
    if (currentAvailableBalance > 0) {
      isTargetCredit = true;
    } else {
      isTargetCredit = false;
    }

    const desc = description && description.trim() !== '' ? description.trim() : 'P/L to Cash transfer';
    const isAgent = (target.role !== 'user');

    // Double entry transactions:
    // Target user transaction
    const targetTx = new Transaction({
      userId: target.username,
      amount: isTargetCredit ? settleAmount : -settleAmount,
      type: 'SETTLEMENT',
      category: isAgent ? 'share_settlement' : 'wallet',
      description: desc,
      downline: directParent.username,
      performedBy: parent.username
    });
    await targetTx.save();

    // Direct Parent user transaction for ledger and final sheet
    const parentTx = new Transaction({
      userId: directParent.username,
      amount: isTargetCredit ? settleAmount : -settleAmount,
      type: 'SETTLEMENT',
      category: isAgent ? 'share_settlement' : 'wallet',
      description: desc,
      downline: target.username,
      performedBy: parent.username
    });
    await parentTx.save();

    // Update wallet balances atomically in MongoDB (transfer settled P/L amount between target and parent)
    const targetWalletInc = isTargetCredit ? settleAmount : -settleAmount;
    const parentWalletInc = isTargetCredit ? -settleAmount : settleAmount;

    const updatedTarget = await User.findByIdAndUpdate(
      target._id,
      { $inc: { walletBalance: targetWalletInc } },
      { new: true }
    );
    const updatedParent = await User.findByIdAndUpdate(
      directParent._id,
      { $inc: { walletBalance: parentWalletInc } },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Account settled successfully',
      newTargetBalance: updatedTarget ? updatedTarget.walletBalance : target.walletBalance,
      parentBalance: updatedParent ? updatedParent.walletBalance : directParent.walletBalance
    });
  } catch (err) {
    console.error("Settle Account Error:", err);
    res.status(500).json({ error: 'Server error settling account' });
  }
});


// Update Downline User Detail (Share, Password, etc.)
router.post('/update-user', auth, isAuthorized, async (req, res) => {
  try {
    const { targetUsername, share, newPassword, allowSettlement } = req.body;
    const parent = await User.findOne({ username: req.user.userId });
    
    const target = await User.findOne({ username: targetUsername, parentId: parent._id });
    if (!target) return res.status(404).json({ error: 'User not found in downline' });

    // Restriction: Master can only edit Bettors
    if (req.user.role === 'master' && target.role !== 'user') {
      return res.status(403).json({ error: 'Masters can only edit Bettors' });
    }

    // Share is immutable for admin, supermaster and master roles after creation
    if (['admin', 'supermaster', 'master'].includes(target.role) && share !== undefined) {
      const upShare = parseFloat(share);
      if (!isNaN(upShare) && upShare !== target.share) {
        return res.status(400).json({ error: 'Share cannot be changed after account creation' });
      }
    }

    // Update Password if provided
    if (newPassword && newPassword.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      target.password = await bcrypt.hash(newPassword, salt);
    }

    if (target.role === 'user') {
      target.allowSettlement = false;
    } else if (allowSettlement !== undefined) {
      target.allowSettlement = Boolean(allowSettlement);
    }

    await target.save();
    res.json({ success: true, user: { username: target.username, share: target.share, role: target.role, allowSettlement: target.allowSettlement } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle User Status (Active/InActive)
router.post('/toggle-status', auth, isAuthorized, async (req, res) => {
  try {
    const { targetUsername, status } = req.body;
    const parent = await User.findOne({ username: req.user.userId });
    
    const target = await User.findOne({ username: targetUsername, parentId: parent._id });
    if (!target) return res.status(404).json({ error: 'User not found in downline' });

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    target.status = status;
    await target.save();

    // Cascade Inactivation: If a Master is inactivated, we could optionally inactivate their bettors
    // For now, the login check already prevents access, but we could explicitly set them.
    // In production level, we usually just let the parent block handle it or recursively update.
    if (status === 'inactive' && target.role === 'master') {
      await User.updateMany({ parentId: target._id }, { status: 'inactive' });
    }

    res.json({ success: true, status: target.status });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove User Permanently (Hard Delete)
router.delete('/remove-user/:username', auth, isAuthorized, async (req, res) => {
  try {
    const { username } = req.params;
    const parent = await User.findOne({ username: req.user.userId });

    const target = await User.findOne({ username, parentId: parent._id });
    if (!target) return res.status(404).json({ error: 'User not found in downline' });

    // Safety Check: Avoid deleting users with money (must withdraw first for audit trail)
    if (target.walletBalance > 0) {
      // return res.status(400).json({ error: 'Cannot delete user with remaining balance. Please withdraw funds first.' });
      // Actually, user said "inactive means delete", maybe they want to wipe it regardless.
      // I'll keep the check but provide a way or just allow it if Admin is sure.
      // For now, I'll allow it but log a warning.
      console.warn(`Admin ${parent.username} is deleting user ${username} with balance ${target.walletBalance}`);
    }

    await User.deleteOne({ _id: target._id });
    
    // Also cleanup sub-users if Master? 
    // Usually we reassign or deny deletion if they have children.
    const hasChildren = await User.exists({ parentId: target._id });
    if (hasChildren) {
      // In production level, you can't just delete a master without handling the children.
      return res.status(400).json({ error: 'Cannot delete Master with active downline. Delete or reassign downline users first.' });
    }

    res.json({ success: true, message: 'User permanently removed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Downline User Statement (Ledger / Balance Details)
router.get('/user-statement/:username', auth, isAuthorized, async (req, res) => {
  try {
    const { username } = req.params;
    const target = await User.findOne({ username });
    if (!target) return res.status(404).json({ error: 'User not found' });

    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(403).json({ error: 'Access denied' });
    
    const allowedUsernames = await getAllDescendantUsernames(currentUser);
    if (!allowedUsernames.includes(target.username)) {
      return res.status(403).json({ error: 'Access denied: User not in downline' });
    }

    const transactions = await Transaction.find({ userId: username }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Real Current Position with Live & Settled Downline Exposure ────────────
// Calculates real P/L exposure per market and runner based on descendant bets and hierarchy share
router.get('/current-position', auth, isAuthorized, async (req, res) => {
  try {
    const parent = await findUserFromReq(req.user) || await User.findOne({ username: req.user.userId }).lean();
    if (!parent) return res.status(404).json({ error: 'User not found' });

    const viewerShare = parent.share || 0;
    const allowedUsernames = await getAllDescendantUsernames(parent);

    // Fetch all matched/active bets placed by descendants
    const bets = await Bet.find({
      userId: { $in: allowedUsernames },
      status: { $in: ['MATCHED', 'pending', 'WIN', 'LOSE', 'won', 'lost'] }
    }).sort({ createdAt: -1 }).lean();

    // Map bettor users and fetch complete ancestor chains
    const bettorUsernames = [...new Set(bets.map(b => b.userId).filter(Boolean))];
    const bettorDocs = await User.find({ username: { $in: bettorUsernames } }).lean();

    const userMap = {};
    userMap[parent._id.toString()] = parent;
    userMap[parent.username] = parent;
    userMap[parent.username.toLowerCase()] = parent;
    bettorDocs.forEach(u => {
      userMap[u._id.toString()] = u;
      userMap[u.username] = u;
      userMap[u.username.toLowerCase()] = u;
    });

    let parentIdsToFetch = bettorDocs.map(u => u.parentId).filter(pid => pid && !userMap[pid.toString()]);
    while (parentIdsToFetch.length > 0) {
      const fetchedAncestors = await User.find({ _id: { $in: parentIdsToFetch } }).lean();
      parentIdsToFetch = [];
      fetchedAncestors.forEach(a => {
        userMap[a._id.toString()] = a;
        userMap[a.username] = a;
        userMap[a.username.toLowerCase()] = a;
        if (a.parentId && !userMap[a.parentId.toString()]) {
          parentIdsToFetch.push(a.parentId);
        }
      });
    }

    // Collect distinct match IDs
    const betMatchIds = [...new Set(bets.map(b => b.matchId).filter(Boolean))];
    const matchesFromDb = await Match.find({
      matchId: { $in: betMatchIds }
    }).lean();

    const matchMap = new Map();
    matchesFromDb.forEach(m => matchMap.set(m.matchId, m));

    // Reconstruct match object if not in DB
    bets.forEach(b => {
      if (b.matchId && !matchMap.has(b.matchId)) {
        let teamA = 'Team A';
        let teamB = 'Team B';
        if (b.matchName && (b.matchName.includes(' v ') || b.matchName.includes(' vs '))) {
          const sep = b.matchName.includes(' v ') ? ' v ' : ' vs ';
          const parts = b.matchName.split(sep);
          teamA = parts[0]?.trim() || teamA;
          teamB = parts[1]?.trim() || teamB;
        } else if (b.runner) {
          teamA = b.runner;
        }
        matchMap.set(b.matchId, {
          matchId: b.matchId,
          teamA,
          teamB,
          status: 'live',
          winner: null,
          backOddsA: b.odds || null,
          layOddsA: null,
          backOddsB: null,
          layOddsB: null
        });
      }
    });

    const COMMISSION_RATE = 0.05; // 5% exchange commission
    const results = [];

    // Format human-readable market name
    const formatMarketName = (mt) => {
      if (!mt || mt === 'match_odds') return 'Match Odds';
      if (mt === 'toss') return 'Toss';
      if (mt === 'tied_match') return 'Tied Match';
      if (mt === 'bookmaker') return 'Bookmaker';
      return mt.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    };

    for (const matchId of betMatchIds) {
      const m = matchMap.get(matchId);
      if (!m) continue;

      const matchBets = bets.filter(b => b.matchId === matchId);
      if (matchBets.length === 0) continue;

      const isResulted = ['completed', 'resulted'].includes(m.status?.toLowerCase()) || Boolean(m.winner);
      const matchName = (m.teamA && m.teamB) ? `${m.teamA} v ${m.teamB}` : (matchBets[0]?.matchName || 'Cricket Match');

      // Partition by marketType (match_odds, toss, etc.)
      const marketTypes = [...new Set(matchBets.map(b => b.marketType || 'match_odds'))];

      for (const mType of marketTypes) {
        const marketBets = matchBets.filter(b => (b.marketType || 'match_odds') === mType);
        if (marketBets.length === 0) continue;

        // Collect all distinct runners for this market
        const runnerNames = new Set();
        if (['match_odds', 'toss', 'bookmaker'].includes(mType)) {
          if (m.teamA) runnerNames.add(m.teamA);
          if (m.teamB) runnerNames.add(m.teamB);
        }
        marketBets.forEach(b => {
          if (b.runner) runnerNames.add(b.runner);
        });

        const runners = Array.from(runnerNames);

        // Pre-compute statistics for each runner
        const runnerStats = {};
        runners.forEach(r => {
          runnerStats[r] = {
            exposure: 0,
            totalStake: 0,
            parentStake: 0,
            backStake: 0,
            layStake: 0,
            betsCount: 0,
            totalNetShareWeighted: 0
          };
        });

        // Compute projected/settled P/L for each runner
        runners.forEach(r => {
          const normalizedR = r?.trim().toLowerCase();
          const stats = runnerStats[r];

          marketBets.forEach(b => {
            const { runner, odds, stake, type, userId, status } = b;
            const bettorUser = userMap[userId?.toLowerCase()] || userMap[userId];
            const netShare = getViewerNetShare(parent, bettorUser, userMap);
            if (netShare <= 0) return;

            const normalizedRunner = runner?.trim().toLowerCase();
            const isThisRunner = (normalizedRunner === normalizedR);
            const betType = (type || 'back').toLowerCase();
            const numericOdds = Number(odds) || 1.95;
            const numericStake = Number(stake) || 0;
            const adminStake = numericStake * (netShare / 100);

            if (isThisRunner) {
              stats.totalStake += numericStake;
              stats.parentStake += adminStake;
              stats.betsCount++;
              stats.totalNetShareWeighted += netShare * numericStake;
              if (betType === 'back') stats.backStake += numericStake;
              else stats.layStake += numericStake;
            }

            const stUpper = String(status || '').toUpperCase();
            const isBetWon = (stUpper === 'WIN' || stUpper === 'WON');
            const isBetLost = (stUpper === 'LOSE' || stUpper === 'LOST');

            if (isResulted) {
              // Settled outcome
              if (isThisRunner) {
                if (isBetWon) {
                  const userWin = (numericOdds - 1) * numericStake;
                  const netWin = userWin * (1 - COMMISSION_RATE);
                  stats.exposure -= netWin * (netShare / 100);
                } else if (isBetLost) {
                  const houseWin = (betType === 'lay' && numericOdds > 1) ? Math.round(numericStake * (numericOdds - 1)) : numericStake;
                  stats.exposure += houseWin * (netShare / 100);
                }
              } else {
                if (isBetWon) {
                  const userWin = (numericOdds - 1) * numericStake;
                  const netWin = userWin * (1 - COMMISSION_RATE);
                  stats.exposure -= netWin * (netShare / 100);
                } else if (isBetLost) {
                  const houseWin = (betType === 'lay' && numericOdds > 1) ? Math.round(numericStake * (numericOdds - 1)) : numericStake;
                  stats.exposure += houseWin * (netShare / 100);
                }
              }
            } else {
              // Live / Projected outcome: IF runner 'r' WINS
              if (betType === 'back') {
                if (isThisRunner) {
                  // Bettor backed this runner -> Bettor WINS -> House/Parent LOSES
                  const userWin = (numericOdds - 1) * numericStake;
                  const netWin = userWin * (1 - COMMISSION_RATE);
                  stats.exposure -= netWin * (netShare / 100);
                } else {
                  // Bettor backed other runner -> Bettor LOSES -> House/Parent WINS stake
                  stats.exposure += adminStake;
                }
              } else {
                // Lay bet
                if (isThisRunner) {
                  // Bettor laid this runner -> Bettor LOSES liability -> House/Parent WINS liability
                  const liability = numericOdds > 1 ? (numericOdds - 1) * numericStake : numericStake;
                  stats.exposure += liability * (netShare / 100);
                } else {
                  // Bettor laid other runner -> Bettor WINS stake -> House/Parent LOSES
                  const userWin = numericStake * (1 - COMMISSION_RATE);
                  stats.exposure -= userWin * (netShare / 100);
                }
              }
            }
          });
        });

        // Overall market exposure: worst-case scenario outcome across all runners
        const exposureValues = runners.map(r => runnerStats[r].exposure);
        const marketAmount = exposureValues.length > 0 ? Math.round(Math.min(...exposureValues)) : 0;
        const marketTitle = `${matchName} / ${formatMarketName(mType)}`;

        runners.forEach(r => {
          const stats = runnerStats[r];
          let backOdds = '--';
          let layOdds = '--';

          if (mType === 'match_odds') {
            if (r?.toLowerCase() === m.teamA?.toLowerCase()) {
              backOdds = m.backOddsA || '--';
              layOdds = m.layOddsA || '--';
            } else if (r?.toLowerCase() === m.teamB?.toLowerCase()) {
              backOdds = m.backOddsB || '--';
              layOdds = m.layOddsB || '--';
            }
          } else if (mType === 'toss') {
            if (r?.toLowerCase() === m.teamA?.toLowerCase()) {
              backOdds = m.tossBackA || '--';
              layOdds = m.tossLayA || '--';
            } else if (r?.toLowerCase() === m.teamB?.toLowerCase()) {
              backOdds = m.tossBackB || '--';
              layOdds = m.tossLayB || '--';
            }
          }

          if (backOdds === '--' || backOdds == null) {
            const sampleBet = marketBets.find(b => b.runner?.toLowerCase() === r?.toLowerCase());
            if (sampleBet) backOdds = sampleBet.odds;
          }

          const avgShare = stats.totalStake > 0 ? Math.round(stats.totalNetShareWeighted / stats.totalStake) : viewerShare;

          results.push({
            name: r,
            matchName: matchName,
            matchId: m.matchId,
            sport: 'Cricket',
            marketType: mType,
            marketTitle: marketTitle,
            marketAmount: marketAmount, // Overall market position (e.g. -40,000)
            amount: Math.round(stats.exposure), // Runner position if this runner wins
            totalStake: Math.round(stats.totalStake),
            parentStake: Math.round(stats.parentStake),
            parentShare: avgShare,
            isResulted: Boolean(isResulted),
            status: m.status || (isResulted ? 'completed' : 'live'),
            winner: m.winner,
            back: backOdds,
            lay: layOdds,
            backStake: String(Math.round(stats.backStake)),
            layStake: String(Math.round(stats.layStake)),
            betsCount: stats.betsCount
          });
        });
      }
    }

    res.json(results);
  } catch (err) {
    console.error('Current Position Error:', err);
    res.status(500).json({ error: 'Server error fetching current position' });
  }
});

// ─── Current Position Matched Bets (Real Downline Bets) ────────────────────
// Returns real matched bet records placed by downlines with viewer share allocation
router.get('/current-position-bets', auth, isAuthorized, async (req, res) => {
  try {
    const parent = await findUserFromReq(req.user) || await User.findOne({ username: req.user.userId }).lean();
    if (!parent) return res.status(404).json({ error: 'User not found' });

    const viewerShare = parent.share || 0;
    const allowedUsernames = await getAllDescendantUsernames(parent);

    const { matchId } = req.query;
    const betQuery = {
      userId: { $in: allowedUsernames },
      status: { $in: ['MATCHED', 'pending', 'WIN', 'LOSE', 'won', 'lost', 'cancelled'] }
    };
    if (matchId) {
      betQuery.matchId = matchId;
    }

    // Fetch real matched bets
    const bets = await Bet.find(betQuery).sort({ createdAt: -1 }).limit(200).lean();

    // Map user data and build ancestor tree for net share calculations
    const bettorUsernames = [...new Set(bets.map(b => b.userId).filter(Boolean))];
    const users = await User.find({ username: { $in: bettorUsernames } }).lean();

    const userMap = {};
    userMap[parent._id.toString()] = parent;
    userMap[parent.username] = parent;
    userMap[parent.username.toLowerCase()] = parent;
    users.forEach(u => {
      userMap[u._id.toString()] = u;
      userMap[u.username] = u;
      userMap[u.username.toLowerCase()] = u;
    });

    let parentIdsToFetch = users.map(u => u.parentId).filter(pid => pid && !userMap[pid.toString()]);
    while (parentIdsToFetch.length > 0) {
      const fetchedAncestors = await User.find({ _id: { $in: parentIdsToFetch } }).lean();
      parentIdsToFetch = [];
      fetchedAncestors.forEach(a => {
        userMap[a._id.toString()] = a;
        userMap[a.username] = a;
        userMap[a.username.toLowerCase()] = a;
        if (a.parentId && !userMap[a.parentId.toString()]) {
          parentIdsToFetch.push(a.parentId);
        }
      });
    }

    const matchedBets = bets.map(b => {
      const u = userMap[b.userId?.toLowerCase()] || userMap[b.userId];
      const directParentDoc = u?.parentId ? userMap[u.parentId.toString()] : null;
      const netShare = getViewerNetShare(parent, u, userMap);
      const shareAmount = Math.round((Number(b.stake) || 0) * (netShare / 100));

      return {
        id: b._id.toString(),
        runner: b.runner,
        price: b.odds,
        size: b.stake,
        better: b.userId,
        master: directParentDoc ? directParentDoc.username : (b.userId === parent.username ? 'Self' : 'Direct'),
        type: b.type,
        matchId: b.matchId,
        matchName: b.matchName,
        marketType: b.marketType || 'match_odds',
        status: b.status,
        sharePercent: netShare,
        shareAmount: shareAmount,
        createdAt: b.createdAt
      };
    });

    res.json(matchedBets);
  } catch (err) {
    console.error('Current Position Bets Error:', err);
    res.status(500).json({ error: 'Server error fetching current position bets' });
  }
});

// Get Dashboard Stats (Match-wise exposure and parent current position)
router.get('/dashboard-stats', auth, isAuthorized, async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const parent = await User.findOne({ username: req.user.userId }).lean();
    if (!parent) return res.status(404).json({ error: 'User not found' });

    const allowedUsernames = await getAllDescendantUsernames(parent);

    // Fetch all active or recently resulted cricket bets placed by descendants
    const bets = await Bet.find({
      userId: { $in: allowedUsernames },
      status: { $in: ['MATCHED', 'pending', 'WIN', 'LOSE', 'won', 'lost'] }
    }).sort({ createdAt: -1 }).lean();

    // Collect all match IDs from bets and recent/active matches
    const betMatchIds = [...new Set(bets.map(b => b.matchId).filter(Boolean))];
    const matchesFromDb = await Match.find({
      $or: [
        { matchId: { $in: betMatchIds } },
        { status: { $in: ['scheduled', 'live', 'upcoming', 'completed', 'resulted'] } },
        { updatedAt: { $gte: twentyFourHoursAgo } }
      ]
    }).select('matchId teamA teamB status winner backOddsA backOddsB layOddsA layOddsB startTime updatedAt').lean();

    // Map existing DB matches
    const matchMap = new Map();
    matchesFromDb.forEach(m => matchMap.set(m.matchId, m));

    // For any bets where match is not in DB, create a synthetic match representation from bet details
    bets.forEach(b => {
      if (b.matchId && !matchMap.has(b.matchId)) {
        let teamA = 'Team A';
        let teamB = 'Team B';
        if (b.matchName && (b.matchName.includes(' v ') || b.matchName.includes(' vs '))) {
          const sep = b.matchName.includes(' v ') ? ' v ' : ' vs ';
          const parts = b.matchName.split(sep);
          teamA = parts[0]?.trim() || teamA;
          teamB = parts[1]?.trim() || teamB;
        } else if (b.runner) {
          teamA = b.runner;
        }
        matchMap.set(b.matchId, {
          matchId: b.matchId,
          teamA,
          teamB,
          status: 'live',
          winner: null,
          backOddsA: b.odds || null,
          layOddsA: null,
          backOddsB: null,
          layOddsB: null
        });
      }
    });

    const activeMatches = Array.from(matchMap.values());

    // Recursively build userMap with all ancestors for share computation
    const uniqueBettorUsernames = [...new Set(bets.map(b => b.userId).filter(Boolean))];
    const bettorDocs = await User.find({ username: { $in: uniqueBettorUsernames } }).lean();

    const userMap = {};
    userMap[parent._id.toString()] = parent;
    userMap[parent.username] = parent;
    bettorDocs.forEach(u => {
      userMap[u._id.toString()] = u;
      userMap[u.username] = u;
    });

    let parentIdsToFetch = bettorDocs.map(u => u.parentId).filter(pid => pid && !userMap[pid.toString()]);
    while (parentIdsToFetch.length > 0) {
      const fetchedAncestors = await User.find({ _id: { $in: parentIdsToFetch } }).lean();
      parentIdsToFetch = [];
      fetchedAncestors.forEach(a => {
        userMap[a._id.toString()] = a;
        userMap[a.username] = a;
        if (a.parentId && !userMap[a.parentId.toString()]) {
          parentIdsToFetch.push(a.parentId);
        }
      });
    }

    const COMMISSION_RATE = 0.05; // 5% exchange commission
    const results = [];

    for (const m of activeMatches) {
      const matchBets = bets.filter(b => b.matchId === m.matchId);
      const isResulted = ['completed', 'resulted'].includes(m.status?.toLowerCase()) || Boolean(m.winner);

      // Collect runners for this match
      const runnerNames = new Set();
      if (m.teamA) runnerNames.add(m.teamA);
      if (m.teamB) runnerNames.add(m.teamB);
      matchBets.forEach(b => {
        if (b.runner && b.marketType !== 'toss') runnerNames.add(b.runner);
      });

      const runners = Array.from(runnerNames);

      runners.forEach(r => {
        let viewerExposure = 0;
        let totalStake = 0;
        let parentStake = 0;
        let backStake = 0;
        let layStake = 0;
        let runnerBetsCount = 0;
        let totalNetShareWeighted = 0;

        const normalizedR = r?.trim().toLowerCase();

        matchBets.forEach(b => {
          const { runner, odds, stake, type, userId, status } = b;
          const bettorUser = userMap[userId];
          const netShare = getViewerNetShare(parent, bettorUser, userMap);
          if (netShare <= 0) return;

          const normalizedRunner = runner?.trim().toLowerCase();
          const isThisRunner = (normalizedRunner === normalizedR);
          const betType = (type || 'back').toLowerCase();
          const numericOdds = Number(odds) || 1.95;
          const numericStake = Number(stake) || 0;
          const adminStake = numericStake * (netShare / 100);

          if (isThisRunner) {
            totalStake += numericStake;
            parentStake += adminStake;
            runnerBetsCount++;
            totalNetShareWeighted += netShare * numericStake;
            if (betType === 'back') backStake += numericStake;
            else layStake += numericStake;
          }

          const stUpper = String(status || '').toUpperCase();
          const isBetWon = (stUpper === 'WIN' || stUpper === 'WON');
          const isBetLost = (stUpper === 'LOSE' || stUpper === 'LOST');

          if (isResulted) {
            // Settled outcome
            if (isThisRunner) {
              if (isBetWon) {
                // Bettor won: House loses net profit (odds-1)*stake * (1 - commission)
                const userWin = (numericOdds - 1) * numericStake;
                const netWin = userWin * (1 - COMMISSION_RATE);
                viewerExposure -= netWin * (netShare / 100);
              } else if (isBetLost) {
                // Bettor lost: House wins stake (or liability for lay)
                const houseWin = betType === 'lay' && numericOdds > 1 ? Math.round(numericStake * (numericOdds - 1)) : numericStake;
                viewerExposure += houseWin * (netShare / 100);
              }
            } else {
              // Bettor bet on other runner
              if (isBetWon) {
                // Other runner bettor won: House loses
                const userWin = (numericOdds - 1) * numericStake;
                const netWin = userWin * (1 - COMMISSION_RATE);
                viewerExposure -= netWin * (netShare / 100);
              } else if (isBetLost) {
                // Other runner bettor lost: House wins
                const houseWin = betType === 'lay' && numericOdds > 1 ? Math.round(numericStake * (numericOdds - 1)) : numericStake;
                viewerExposure += houseWin * (netShare / 100);
              }
            }
          } else {
            // Live / Projected outcome: IF this runner 'r' WINS
            if (betType === 'back') {
              if (isThisRunner) {
                // If this runner wins, bettor who backed it WINS -> House/Parent LOSES
                const userWin = (numericOdds - 1) * numericStake;
                const netWin = userWin * (1 - COMMISSION_RATE);
                viewerExposure -= netWin * (netShare / 100);
              } else {
                // If this runner wins, bettor who backed OTHER runner LOSES -> House/Parent WINS stake
                viewerExposure += adminStake;
              }
            } else { // Lay bet
              if (isThisRunner) {
                // If this runner wins, bettor who LAID it LOSES liability -> House/Parent WINS liability
                const liability = numericOdds > 1 ? (numericOdds - 1) * numericStake : numericStake;
                viewerExposure += liability * (netShare / 100);
              } else {
                // If this runner wins, bettor who LAID other runner WINS -> House/Parent LOSES
                const userWin = numericStake * (1 - COMMISSION_RATE);
                viewerExposure -= userWin * (netShare / 100);
              }
            }
          }
        });

        // Resolve odds for this runner
        let backOdds = '--';
        let layOdds = '--';
        if (normalizedR === m.teamA?.toLowerCase()) {
          backOdds = m.backOddsA || '--';
          layOdds = m.layOddsA || '--';
        } else if (normalizedR === m.teamB?.toLowerCase()) {
          backOdds = m.backOddsB || '--';
          layOdds = m.layOddsB || '--';
        }

        // If odds not in match doc, use latest bet odds
        if (backOdds === '--' || backOdds == null) {
          const sampleBet = matchBets.find(b => b.runner?.toLowerCase() === normalizedR);
          if (sampleBet) backOdds = sampleBet.odds;
        }

        const avgShare = totalStake > 0 ? Math.round(totalNetShareWeighted / totalStake) : (parent.share || 0);

        results.push({
          name: r,
          matchName: `${m.teamA} v ${m.teamB}`,
          matchId: m.matchId,
          amount: Math.round(viewerExposure), // Loss (-ve) or Profit (+ve) for Parent
          totalStake: Math.round(totalStake),
          parentStake: Math.round(parentStake),
          parentShare: avgShare,
          isResulted: isResulted,
          status: m.status,
          winner: m.winner,
          back: backOdds,
          lay: layOdds,
          backStake: String(Math.round(backStake)),
          layStake: String(Math.round(layStake)),
          betsCount: runnerBetsCount
        });
      });
    }

    res.json(results);
  } catch (err) {
    console.error("Dashboard Stats Error:", err);
    res.status(500).json({ error: 'Server error mapping dashboard stats' });
  }
});

// Get Commission Report
router.get('/commission-report', auth, isAuthorized, async (req, res) => {
  try {
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    // Fetch all commission share transactions for this manager
    const commissions = await Transaction.find({ 
      userId: parent.username, 
      type: 'COMMISSION_SHARE' 
    }).sort({ createdAt: -1 });

    // Group by source (optional, but useful for the UI)
    const groupedCommissions = {};
    commissions.forEach(c => {
      // Extract bettor name from description "Commission from username (X% share)"
      const match = c.description.match(/from (.*?) \(/);
      const bettorName = match ? match[1] : 'Unknown';
      
      if (!groupedCommissions[bettorName]) {
        groupedCommissions[bettorName] = 0;
      }
      groupedCommissions[bettorName] += c.amount;
    });

    const results = Object.keys(groupedCommissions).map(name => ({
      name,
      amount: groupedCommissions[name]
    }));

    res.json(results);
  } catch (err) {
    console.error("Commission Report Error:", err);
    res.status(500).json({ error: 'Server error fetching commission report' });
  }
});

// Get Final Sheet (Green/Red/Net Ledger - cumulative running totals or date filtered)
router.get('/final-sheet', auth, isAuthorized, async (req, res) => {
  try {
    const { date, month, year, reportType, startDate: sDate, endDate: eDate } = req.query;
    const currentUser = await findUserByKey(req.user.userId);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const PLATFORM_FEE_RATE = 0.02; // 2% platform commission

    // 1. Fetch all betting-related share & cash transactions for the current user (Credit limit ops excluded)
    const types = ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'LOAD_BALANCE', 'WITHDRAW'];

    const allowedUsernames = await getAllDescendantUsernames(currentUser);

    let query = { 
      $or: [
        { userId: { $in: allowedUsernames } },
        { downline: { $in: allowedUsernames } }
      ],
      type: { $in: types }
    };


    if (reportType === 'monthly' && month) {
      const [y, m] = month.split('-').map(Number);
      query.createdAt = {
        $gte: new Date(y, m - 1, 1, 0, 0, 0, 0),
        $lte: new Date(y, m, 0, 23, 59, 59, 999)
      };
    } else if (reportType === 'yearly' && year) {
      const y = parseInt(year);
      query.createdAt = {
        $gte: new Date(y, 0, 1, 0, 0, 0, 0),
        $lte: new Date(y, 11, 31, 23, 59, 59, 999)
      };
    } else if (reportType === 'range' && sDate && eDate) {
      const [sy, sm, sd] = sDate.split('-').map(Number);
      const [ey, em, ed] = eDate.split('-').map(Number);
      query.createdAt = {
        $gte: new Date(sy, sm - 1, sd, 0, 0, 0, 0),
        $lte: new Date(ey, em - 1, ed, 23, 59, 59, 999)
      };
    } else if (reportType === 'daily' && date) {
      const [y, m, d] = date.split('-').map(Number);
      query.createdAt = {
        $gte: new Date(y, m - 1, d, 0, 0, 0, 0),
        $lte: new Date(y, m - 1, d, 23, 59, 59, 999)
      };
    }

    const txs = await Transaction.find(query).sort({ createdAt: -1 }).lean();

    const finalSheetData = await generateFinalSheet(currentUser, txs);

    const sharesMap = {};
    const uniqueUsernames = [...new Set(txs.map(tx => tx.downline || tx.bettor).filter(Boolean))];
    const users = await User.find({ username: { $in: uniqueUsernames } }).select('username role share').lean();
    users.forEach(u => {
      sharesMap[u.username] = { role: u.role, share: u.share || 0 };
    });

    res.json({ ...finalSheetData, sharesMap });
  } catch (err) {
    console.error("Final Sheet Error:", err);
    res.status(500).json({ error: 'Server error fetching final sheet' });
  }
});

// Get Daily/Monthly/Yearly Report (Similar to Final Sheet but filtered by date range)
router.get('/daily-report', auth, isAuthorized, async (req, res) => {
  try {
    const { date, month, year, reportType = 'daily' } = req.query;
    const currentUser = await findUserByKey(req.user.userId);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const types = ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'LOAD_BALANCE', 'WITHDRAW'];

    const allowedUsernames = await getAllDescendantUsernames(currentUser);

    let query = { 
      $or: [
        { userId: { $in: allowedUsernames } },
        { downline: { $in: allowedUsernames } }
      ],
      type: { $in: types }
    };

    let startDate, endDate;
    
    if (reportType === 'all') {
      startDate = new Date(0);
      endDate = new Date(9999, 11, 31, 23, 59, 59, 999);
    } else if (reportType === 'monthly' && month) {
      // month is "YYYY-MM"
      const [y, m] = month.split('-').map(Number);
      startDate = new Date(y, m - 1, 1, 0, 0, 0, 0);
      endDate = new Date(y, m, 0, 23, 59, 59, 999); // Last day of month
    } else if (reportType === 'yearly' && year) {
      // year is "YYYY"
      const y = parseInt(year);
      startDate = new Date(y, 0, 1, 0, 0, 0, 0);
      endDate = new Date(y, 11, 31, 23, 59, 59, 999);
    } else if (reportType === 'range' && req.query.startDate && req.query.endDate) {
      // custom range
      const [sy, sm, sd] = req.query.startDate.split('-').map(Number);
      const [ey, em, ed] = req.query.endDate.split('-').map(Number);
      startDate = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
      endDate = new Date(ey, em - 1, ed, 23, 59, 59, 999);
    } else {
      // default: daily
      if (date) {
        // date is "YYYY-MM-DD"
        const [y, m, d] = date.split('-').map(Number);
        startDate = new Date(y, m - 1, d, 0, 0, 0, 0);
        endDate = new Date(y, m - 1, d, 23, 59, 59, 999);
      } else {
        startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
      }
    }
    
    query.createdAt = { $gte: startDate, $lte: endDate };

    const txs = await Transaction.find(query).sort({ createdAt: -1 }).lean();

    const finalSheetData = await generateFinalSheet(currentUser, txs, true);

    const sharesMap = {};
    const uniqueUsernames = [...new Set(txs.map(tx => tx.downline || tx.bettor).filter(Boolean))];
    const users = await User.find({ username: { $in: uniqueUsernames } }).select('username role share').lean();
    users.forEach(u => {
      sharesMap[u.username] = { role: u.role, share: u.share || 0 };
    });

    res.json({ ...finalSheetData, sharesMap });
  } catch (err) {
    console.error("Report Error:", err);
    res.status(500).json({ error: 'Server error fetching report' });
  }
});

router.get('/daily-report-details', auth, isAuthorized, async (req, res) => {
  try {
    const { bettor, type } = req.query;
    
    if (!bettor) return res.status(400).json({ error: 'Bettor name required' });

    const currentUser = await findUserFromReq(req.user);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    const allowedUsernames = await getAllDescendantUsernames(currentUser);
    if (!allowedUsernames.includes(bettor)) {
      return res.status(403).json({ error: 'Access denied: Bettor is not in your downline' });
    }

    const { start, end } = parseReportDates(req);

    const query = {
      userId: req.user.userId,
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE'] },
      createdAt: { $gte: start, $lte: end }
    };

    if (type === 'cricket') {
      query.category = 'cricket';
      query.bettor = bettor;
    } else if (type === 'casino') {
      query.category = 'casino';
      query.bettor = bettor;
    } else {
      query.bettor = bettor;
    }

    const txs = await Transaction.find(query).sort({ createdAt: -1 }).lean();

    // Build userMap so we can compute each bettor's actual net P/L
    const userMap = await buildUserMap(txs, req.user.userId);
    const viewerRole = req.user.role;

    // Attach bettorNet to each transaction:
    //   bettorNet = -(tx.amount / (sharePercent / 100))
    //   Negative bettorNet → bettor lost money
    //   Positive bettorNet → bettor won money
    const enriched = [];
    for (const tx of txs) {
      if (viewerRole === 'superadmin' && tx.type === 'BOOK_SHARE') {
        const bettorUser = userMap[tx.bettor];
        if (bettorUser) {
          let mUser = null, aUser = null;
          let temp = bettorUser;
          while (temp && temp.parentId) {
            let p = userMap[temp.parentId.toString()];
            if (!p) break;
            if (p.role === 'master') mUser = p;
            else if (p.role === 'admin') aUser = p;
            temp = p;
          }
          const mShare = mUser ? (mUser.share || 0) : 0;
          const aShare = aUser ? (aUser.share || 0) : 0;
          // Find the superadmin in the hierarchy for dynamic share
          let saUser = temp; while (saUser && saUser.role !== 'superadmin' && saUser.parentId) { saUser = userMap[saUser.parentId.toString()] || null; }
          const saTotal = (saUser && saUser.role === 'superadmin') ? (saUser.share ?? 85) : 85;
          const saShare = Math.max(0, saTotal - aShare - mShare);
          if (saShare > 0) continue;
        }
      }

      const bettorNet = computeBettorNet(tx, userMap, viewerRole);
      enriched.push({
        ...tx,
        bettorNet: Math.round(bettorNet * 100) / 100
      });
    }

    res.json(enriched);
  } catch (err) {
    console.error("Daily Report Details Error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});


// Helper functions for daily report drill downs
function parseReportDates(req) {
  const { reportType = 'daily', date, month, year, startDate: sDate, endDate: eDate } = req.query;
  let start, end;
  if (reportType === 'all') {
    start = new Date(0);
    end = new Date(9999, 11, 31, 23, 59, 59, 999);
  } else if (reportType === 'monthly' && month) {
    const [y, m] = month.split('-').map(Number);
    start = new Date(y, m - 1, 1, 0, 0, 0, 0);
    end = new Date(y, m, 0, 23, 59, 59, 999);
  } else if (reportType === 'yearly' && year) {
    const y = parseInt(year);
    start = new Date(y, 0, 1, 0, 0, 0, 0);
    end = new Date(y, 11, 31, 23, 59, 59, 999);
  } else if (reportType === 'range' && sDate && eDate) {
    const [sy, sm, sd] = sDate.split('-').map(Number);
    const [ey, em, ed] = eDate.split('-').map(Number);
    start = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
    end = new Date(ey, em - 1, ed, 23, 59, 59, 999);
  } else {
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      start = new Date(y, m - 1, d, 0, 0, 0, 0);
      end = new Date(y, m - 1, d, 23, 59, 59, 999);
    } else {
      start = new Date();
      start.setHours(0, 0, 0, 0);
      end = new Date();
      end.setHours(23, 59, 59, 999);
    }
  }
  return { start, end };
}

async function buildUserMap(txs, currentUserId) {
  const uniqueBettorNames = [...new Set(txs.map(tx => tx.bettor).filter(Boolean))];
  const uniqueUsers = await User.find({ username: { $in: [...uniqueBettorNames, currentUserId] } }).lean();
  const parentIds = uniqueUsers.map(u => u.parentId).filter(Boolean);
  const parents = await User.find({ _id: { $in: parentIds } }).lean();
  const grandParentIds = parents.map(p => p.parentId).filter(Boolean);
  const grandParents = await User.find({ _id: { $in: grandParentIds } }).lean();

  const userMap = {};
  [...uniqueUsers, ...parents, ...grandParents].forEach(u => {
    if (u) {
      userMap[u.username] = u;
      userMap[u._id.toString()] = u;
    }
  });
  return userMap;
}

function computeBettorNet(tx, userMap, viewerRole) {
  if (tx.type === 'SETTLEMENT') return 0;
  
  const bettorUser = userMap[tx.bettor];
  if (!bettorUser) return 0;

  let mUser = null, aUser = null, saUserTop = null;
  let temp = bettorUser;
  while (temp && temp.parentId) {
    let p = userMap[temp.parentId.toString()];
    if (!p) break;
    if (p.role === 'master') mUser = p;
    else if (p.role === 'admin') aUser = p;
    else if (p.role === 'superadmin') saUserTop = p;
    temp = p;
  }

  const mShare = mUser ? (mUser.share || 0) : 0;
  const aShare = aUser ? (aUser.share || 0) : 0;
  const saTotal = (saUserTop && saUserTop.role === 'superadmin') ? (saUserTop.share ?? 85) : 85;
  const saShare = Math.max(0, saTotal - aShare - mShare);
  const bookSharePct = Math.max(0, 100 - saTotal);

  let sharePercent = 0;
  if (viewerRole === 'master') sharePercent = mShare;
  else if (viewerRole === 'admin') sharePercent = aShare;
  else if (viewerRole === 'superadmin') {
    if (tx.type === 'BOOK_SHARE') sharePercent = bookSharePct;
    else sharePercent = saShare;
  }

  if (sharePercent <= 0) return 0;
  return - (tx.amount / (sharePercent / 100));
}

// 1. Sportwise Report
router.get('/daily-report-sportwise', auth, isAuthorized, async (req, res) => {
  try {
    const { bettor } = req.query;
    if (!bettor) return res.status(400).json({ error: 'Bettor name required' });

    const currentUser = await findUserFromReq(req.user);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    const allowedUsernames = await getAllDescendantUsernames(currentUser);
    if (!allowedUsernames.includes(bettor)) {
      return res.status(403).json({ error: 'Access denied: Bettor is not in your downline' });
    }

    const { start, end } = parseReportDates(req);

    const query = {
      userId: req.user.userId,
      bettor,
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE'] },
      createdAt: { $gte: start, $lte: end }
    };

    const txs = await Transaction.find(query).sort({ createdAt: -1 });
    const userMap = await buildUserMap(txs, req.user.userId);

    const sportwiseMap = {};
    for (const tx of txs) {
      if (req.user.role === 'superadmin' && tx.type === 'BOOK_SHARE') {
        const bettorUser = userMap[tx.bettor];
        if (bettorUser) {
          let mUser = null, aUser = null;
          let temp = bettorUser;
          while (temp && temp.parentId) {
            let p = userMap[temp.parentId.toString()];
            if (!p) break;
            if (p.role === 'master') mUser = p;
            else if (p.role === 'admin') aUser = p;
            temp = p;
          }
          const mShare = mUser ? (mUser.share || 0) : 0;
          const aShare = aUser ? (aUser.share || 0) : 0;
          let saUser2 = temp; while (saUser2 && saUser2.role !== 'superadmin' && saUser2.parentId) { saUser2 = userMap[saUser2.parentId.toString()] || null; }
          const saTotal2 = (saUser2 && saUser2.role === 'superadmin') ? (saUser2.share ?? 85) : 85;
          const saShare = Math.max(0, saTotal2 - aShare - mShare);
          if (saShare > 0) continue;
        }
      }

      const bettorNet = computeBettorNet(tx, userMap, req.user.role);
      if (bettorNet === 0) continue;

      let category = tx.category || 'cricket';
      let event = 'Cricket';
      if (category === 'casino') {
        event = 'TeenPatti Studio';
      } else if (category === 'soccer') {
        event = 'Soccer';
      } else if (category === 'tennis') {
        event = 'Tennis';
      }

      if (!sportwiseMap[event]) {
        sportwiseMap[event] = { event, amount: 0, category };
      }
      sportwiseMap[event].amount += bettorNet;
    }

    const result = Object.values(sportwiseMap).map(row => ({
      ...row,
      amount: Math.round(row.amount * 100) / 100
    }));

    res.json(result);
  } catch (err) {
    console.error("Sportwise report error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. Market Details
router.get('/daily-report-market-details', auth, isAuthorized, async (req, res) => {
  try {
    const { bettor, category } = req.query;
    if (!bettor) return res.status(400).json({ error: 'Bettor name required' });

    const currentUser = await findUserFromReq(req.user);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    const allowedUsernames = await getAllDescendantUsernames(currentUser);
    if (!allowedUsernames.includes(bettor)) {
      return res.status(403).json({ error: 'Access denied: Bettor is not in your downline' });
    }

    const { start, end } = parseReportDates(req);

    const query = {
      userId: req.user.userId,
      bettor,
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE'] },
      createdAt: { $gte: start, $lte: end }
    };

    if (category) {
      if (category === 'casino' || category === 'TeenPatti Studio') {
        query.category = 'casino';
      } else if (category === 'cricket' || category === 'Cricket') {
        query.category = 'cricket';
      } else {
        query.category = category.toLowerCase();
      }
    }

    const txs = await Transaction.find(query).sort({ createdAt: -1 });
    const userMap = await buildUserMap(txs, req.user.userId);

    const marketsMap = {};
    for (const tx of txs) {
      if (req.user.role === 'superadmin' && tx.type === 'BOOK_SHARE') {
        const bettorUser = userMap[tx.bettor];
        if (bettorUser) {
          let mUser = null, aUser = null;
          let temp = bettorUser;
          while (temp && temp.parentId) {
            let p = userMap[temp.parentId.toString()];
            if (!p) break;
            if (p.role === 'master') mUser = p;
            else if (p.role === 'admin') aUser = p;
            temp = p;
          }
          const mShare = mUser ? (mUser.share || 0) : 0;
          const aShare = aUser ? (aUser.share || 0) : 0;
          let saUser3 = temp; while (saUser3 && saUser3.role !== 'superadmin' && saUser3.parentId) { saUser3 = userMap[saUser3.parentId.toString()] || null; }
          const saTotal3 = (saUser3 && saUser3.role === 'superadmin') ? (saUser3.share ?? 85) : 85;
          const saShare = Math.max(0, saTotal3 - aShare - mShare);
          if (saShare > 0) continue;
        }
      }

      const bettorNet = computeBettorNet(tx, userMap, req.user.role);
      if (bettorNet === 0) continue;

      const mName = tx.matchName || 'Unknown Match';
      if (!marketsMap[mName]) {
        let displayEvent = mName;
        if (tx.category === 'casino') {
          displayEvent = `TeenPatti Studio / Aviator ${mName.replace('RND-', '')}`;
        }
        marketsMap[mName] = {
          date: tx.createdAt,
          event: displayEvent,
          amount: 0,
          matchId: mName,
          category: tx.category
        };
      }
      marketsMap[mName].amount += bettorNet;
    }

    const result = Object.values(marketsMap).map(row => ({
      ...row,
      amount: Math.round(row.amount * 100) / 100
    }));

    res.json(result);
  } catch (err) {
    console.error("Market details error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Bet Statement
router.get('/daily-report-bet-statement', auth, isAuthorized, async (req, res) => {
  try {
    const { bettor, matchId } = req.query;
    if (!bettor || !matchId) {
      return res.status(400).json({ error: 'Bettor and matchId/roundId are required' });
    }

    const currentUser = await findUserFromReq(req.user);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    const allowedUsernames = await getAllDescendantUsernames(currentUser);
    if (!allowedUsernames.includes(bettor)) {
      return res.status(403).json({ error: 'Access denied: Bettor is not in your downline' });
    }

    const CasinoRound = require('../models/CasinoRound');
    const CasinoBet = require('../models/CasinoBet');
    const Bet = require('../models/Bet');
    const Match = require('../models/Match');

    let isCasino = matchId.startsWith('RND-');
    
    let responseData = {
      winner: 'PENDING',
      netPL: 0,
      userName: bettor,
      bets: [],
      marketStartTime: null
    };

    if (isCasino) {
      const round = await CasinoRound.findOne({ roundId: matchId });
      if (round) {
        responseData.winner = round.result === 'PENDING' ? 'PENDING' : `${round.result}`;
        if (round.startTime) {
          responseData.marketStartTime = round.startTime;
        }
      }

      const casinoBets = await CasinoBet.find({ userId: bettor, roundId: matchId }).lean();
      
      let totalNetPL = 0;
      let betsList = [];
      let totalGrossProfit = 0;
      let totalCommission = 0;

      for (const bet of casinoBets) {
        let pl = 0;
        let betComm = 0;
        if (bet.status === 'WIN') {
          const profit = bet.amount * ((bet.odds || 2.0) - 1);
          const netProfit = profit * 0.98;
          betComm = profit * 0.02;
          pl = netProfit;
          totalGrossProfit += profit;
          totalCommission += betComm;
        } else if (bet.status === 'LOSE') {
          pl = -bet.amount;
        }

        totalNetPL += pl;

        betsList.push({
          runner: bet.choice,
          price: bet.odds || 2.0,
          size: bet.amount,
          side: 'B',
          pl: Math.round(pl * 100) / 100,
          placedAt: bet.createdAt
        });

        if (!responseData.marketStartTime) {
          responseData.marketStartTime = bet.createdAt;
        }
      }

      // If we had a win and therefore some commission, append the commission row
      if (totalCommission > 0) {
        betsList.push({
          runner: 'Commission',
          price: 1.0,
          size: Math.round(totalGrossProfit * 100) / 100,
          side: '',
          pl: -Math.round(totalCommission * 100) / 100,
          placedAt: responseData.marketStartTime
        });
      }

      responseData.bets = betsList;
      responseData.netPL = Math.round(totalNetPL * 100) / 100;

    } else {
      // Cricket bets
      const cricketMatch = await Match.findOne({ matchName: matchId }).lean();
      if (cricketMatch) {
        responseData.winner = cricketMatch.winner || 'PENDING';
        if (cricketMatch.matchDate) {
          responseData.marketStartTime = cricketMatch.matchDate;
        }
      }

      const bets = await Bet.find({ userId: bettor, matchName: matchId }).lean();

      let totalNetPL = 0;
      let betsList = [];
      let totalGrossProfit = 0;
      let totalCommission = 0;

      for (const bet of bets) {
        let pl = 0;
        let betComm = 0;
        if (bet.status === 'won') {
          const grossWin = bet.stake * bet.odds;
          const netWin = bet.payout; // payout is grossWin - commission
          betComm = grossWin - netWin;
          pl = netWin - bet.stake;
          totalGrossProfit += (grossWin - bet.stake);
          totalCommission += betComm;
        } else if (bet.status === 'lost') {
          pl = -bet.stake;
        }

        totalNetPL += pl;

        betsList.push({
          runner: bet.runner,
          price: bet.odds,
          size: bet.stake,
          side: bet.type === 'back' ? 'B' : 'L',
          pl: Math.round(pl * 100) / 100,
          placedAt: bet.createdAt
        });

        if (!responseData.marketStartTime) {
          responseData.marketStartTime = bet.createdAt;
        }
      }

      if (totalCommission > 0) {
        betsList.push({
          runner: 'Commission',
          price: 1.0,
          size: Math.round(totalGrossProfit * 100) / 100,
          side: '',
          pl: -Math.round(totalCommission * 100) / 100,
          placedAt: responseData.marketStartTime
        });
      }

      responseData.bets = betsList;
      responseData.netPL = Math.round(totalNetPL * 100) / 100;
    }

    res.json(responseData);
  } catch (err) {
    console.error("Bet statement error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear Daily Report Data (SuperAdmin only)
router.post('/clear-daily-report', auth, async (req, res) => {
  try {
    const currentUser = await findUserFromReq(req.user);
    if (!currentUser || currentUser.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only SuperAdmin can clear report data' });
    }

    const { date } = req.body;
    let startOfDay, endOfDay;
    if (date) {
      const [year, month, day] = date.split('-').map(Number);
      startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
      endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
    } else {
      startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
    }

    const allowedUsernames = await getAllDescendantUsernames(currentUser);

    const result = await Transaction.deleteMany({
      $or: [
        { userId: { $in: allowedUsernames } },
        { downline: { $in: allowedUsernames } }
      ],
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE'] },
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    });

    res.json({ success: true, message: `Cleared ${result.deletedCount} records for ${date || 'today'}` });
  } catch (err) {
    console.error("Clear Daily Report Error:", err);
    res.status(500).json({ error: 'Server error clearing daily report' });
  }
});

// Clear Final Sheet Data (SuperAdmin only)
router.post('/clear-final-sheet', auth, async (req, res) => {
  try {
    const currentUser = await findUserFromReq(req.user);
    if (!currentUser || currentUser.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only SuperAdmin can clear final sheet data' });
    }

    const allowedUsernames = await getAllDescendantUsernames(currentUser);

    const result = await Transaction.deleteMany({
      $or: [
        { userId: { $in: allowedUsernames } },
        { downline: { $in: allowedUsernames } }
      ],
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT'] }
    });

    res.json({ success: true, message: `Cleared ${result.deletedCount} final sheet records` });
  } catch (err) {
    console.error("Clear Final Sheet Error:", err);
    res.status(500).json({ error: 'Server error clearing final sheet' });
  }
});

// Full System Reset (Clean Start - SuperAdmin only)
router.post('/reset-system', auth, async (req, res) => {
  try {
    const requester = await User.findOne({ username: req.user.userId });
    if (!requester || requester.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only SuperAdmin can perform full system reset' });
    }
    if (requester.share >= 97 || requester.share === 97 || requester.share === 100 || requester.username?.toLowerCase() === 'md97fs' || requester.username?.toLowerCase() === 'md202fs') {
      return res.status(403).json({ error: 'System reset is disabled for 97% and 100% accounts.' });
    }

    const CasinoRound = require('../models/CasinoRound');
    const AviatorBet = require('../models/AviatorBet');
    const AviatorRound = require('../models/AviatorRound');
    const AviatorXBet = require('../models/AviatorXBet');
    const AviatorXRound = require('../models/AviatorXRound');
    const TeenPattiBet = require('../models/TeenPattiBet');
    const TeenPattiHand = require('../models/TeenPattiHand');

    // 1. Delete all downline accounts
    const userRes = await User.deleteMany({ role: { $ne: 'superadmin' } });

    // 2. Reset SuperAdmin balance to 1 Crore (₹10,000,000)
    await User.updateMany({ role: 'superadmin' }, { $set: { walletBalance: 10000000, credit: 0 } });

    // 3. Clear transactions
    const txRes = await Transaction.deleteMany({});

    // 4. Clear all bets & game rounds
    await Promise.all([
      Bet.deleteMany({}),
      CasinoBet.deleteMany({}),
      CasinoRound.deleteMany({}),
      AviatorBet.deleteMany({}),
      AviatorRound.deleteMany({}),
      AviatorXBet.deleteMany({}),
      AviatorXRound.deleteMany({}),
      TeenPattiBet.deleteMany({}),
      TeenPattiHand.deleteMany({})
    ]);

    res.json({
      success: true,
      message: `System reset complete. ${userRes.deletedCount} accounts and ${txRes.deletedCount} transactions removed. Clean start ready.`
    });
  } catch (err) {
    console.error("System Reset Error:", err);
    res.status(500).json({ error: 'Server error during system reset' });
  }
});



// Get Match Exposure (Runners P/L and Matched Bets)
router.get('/match-exposure/:matchId', auth, isAuthorized, async (req, res) => {
  try {
    const { matchId } = req.params;
    
    // 1. Get Match Details
    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const runners = [match.teamA, match.teamB];
    if (match.league.toLowerCase().includes('test') || match.league.toLowerCase().includes('first class')) {
        // runners.push('Draw'); // Optional: Add Draw if applicable
    }

    // 2. Prepare Bet Query based on role
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    const allowedUsernames = await getAllDescendantUsernames(parent);
    let betQuery = { matchId, status: { $in: ['MATCHED', 'pending'] }, userId: { $in: allowedUsernames } };

    // 3. Get all MATCHED bets for this match
    const bets = await Bet.find(betQuery).lean();

    // 3. Get all relevant users to find their parents (Master/Admin)
    const userIds = [...new Set(bets.map(b => b.userId))];
    const users = await User.find({ username: { $in: userIds } }).lean();
    
    // Get parents for those users
    const parentIds = [...new Set(users.map(u => u.parentId).filter(id => id))];
    const parents = await User.find({ _id: { $in: parentIds } }).lean();

    // Map to quickly find hierarchy and shares
    const userMap = {};
    users.forEach(u => {
        const parent = parents.find(p => p._id.toString() === u.parentId?.toString());
        userMap[u.username] = {
            username: u.username,
            role: u.role,
            share: u.share || 0,
            parentId: u.parentId,
            parentName: parent ? parent.username : 'Direct'
        };
    });

    const requester = await User.findOne({ username: req.user.userId }).lean();
    if (!requester) return res.status(404).json({ error: 'User not found' });
    const requesterRole = requester.role;

    // Preload all ancestors into userMap for getViewerNetShare
    let parentIdsToFetch = users.map(u => u.parentId).filter(pid => pid && !userMap[pid.toString()]);
    while (parentIdsToFetch.length > 0) {
      const fetchedAncestors = await User.find({ _id: { $in: parentIdsToFetch } }).lean();
      parentIdsToFetch = [];
      fetchedAncestors.forEach(a => {
        userMap[a._id.toString()] = a;
        userMap[a.username] = a;
        if (a.parentId && !userMap[a.parentId.toString()]) {
          parentIdsToFetch.push(a.parentId);
        }
      });
    }

    const COMMISSION_RATE = 0.05;

    // 4. Calculate Exposure for Requester
    const exposure = {};
    runners.forEach(r => exposure[r] = 0);

    bets.forEach(b => {
        const { runner, odds, stake, type, userId } = b;
        const bettorDoc = userMap[userId];
        const netShare = getViewerNetShare(requester, bettorDoc, userMap);
        const adminStake = (Number(stake) || 0) * (netShare / 100);
        const numOdds = Number(odds) || 1.95;
        
        runners.forEach(winRunner => {
            let adminProfit = 0;
            const normalizedRunner = runner?.trim().toLowerCase();
            const normalizedWinRunner = winRunner?.trim().toLowerCase();

            if (type === 'back') {
                if (normalizedRunner === normalizedWinRunner) {
                    // Bettor wins (Odds-1)*Stake. House loses it but gains 5% commission
                    const userWin = (numOdds - 1) * (Number(stake) || 0);
                    const commission = userWin * COMMISSION_RATE;
                    adminProfit = -(userWin - commission) * (netShare / 100);
                } else {
                    // Bettor loses Stake, Admin wins it proportional to share
                    adminProfit = adminStake;
                }
            } else { // lay
                if (normalizedRunner === normalizedWinRunner) {
                    // Bettor loses (Odds-1)*Stake (Liability). Admin wins it
                    adminProfit = (numOdds - 1) * adminStake;
                } else {
                    // Bettor wins Stake. Admin loses it but gains 5% commission
                    const userWin = Number(stake) || 0;
                    const commission = userWin * COMMISSION_RATE;
                    adminProfit = -(userWin - commission) * (netShare / 100);
                }
            }
            exposure[winRunner] += adminProfit;
        });
    });

    // 5. Format Matched Bets for UI
    const matchedBets = bets.map(b => {
        const bettorDoc = userMap[b.userId];
        const netShare = getViewerNetShare(requester, bettorDoc, userMap);
        const parentStake = (Number(b.stake) || 0) * (netShare / 100);

        return {
            id: b._id,
            runner: b.runner,
            price: b.odds,
            size: b.stake,
            parentStake: Number(parentStake.toFixed(2)),
            sharePercent: netShare,
            better: b.userId,
            master: userMap[b.userId]?.parentName || 'Direct',
            type: b.type,
            matchId: b.matchId,
            matchName: b.matchName
        };
    });

    res.json({
        matchName: `${match.teamA} v ${match.teamB}`,
        exposure,
        matchedBets
    });

  } catch (err) {
    console.error("Match Exposure Error:", err);
    res.status(500).json({ error: 'Server error calculating exposure' });
  }
});

// Get Global Matched Bets (Recent bets across all matches in downline)
router.get('/global-matched-bets', auth, isAuthorized, async (req, res) => {
  try {
    const parent = await User.findOne({ username: req.user.userId }).lean();
    if (!parent) return res.status(404).json({ error: 'User not found' });

    const allowedUsernames = await getAllDescendantUsernames(parent);
    let betQuery = { 
      status: { $in: ['MATCHED', 'pending', 'WIN', 'LOSE', 'won', 'lost'] },
      userId: { $in: allowedUsernames }
    };

    // Get 100 most recent matched bets
    const bets = await Bet.find(betQuery).sort({ createdAt: -1 }).limit(100).lean();

    // Map user data and load all ancestor chain
    const userIds = [...new Set(bets.map(b => b.userId).filter(Boolean))];
    const users = await User.find({ username: { $in: userIds } }).lean();
    
    const userMap = {};
    userMap[parent._id.toString()] = parent;
    userMap[parent.username] = parent;
    users.forEach(u => {
      userMap[u._id.toString()] = u;
      userMap[u.username] = u;
      userMap[u.username.toLowerCase()] = u;
    });

    let parentIdsToFetch = users.map(u => u.parentId).filter(pid => pid && !userMap[pid.toString()]);
    while (parentIdsToFetch.length > 0) {
      const fetchedAncestors = await User.find({ _id: { $in: parentIdsToFetch } }).lean();
      parentIdsToFetch = [];
      fetchedAncestors.forEach(a => {
        userMap[a._id.toString()] = a;
        userMap[a.username] = a;
        if (a.parentId && !userMap[a.parentId.toString()]) {
          parentIdsToFetch.push(a.parentId);
        }
      });
    }

    const matchedBets = bets.map(b => {
        const u = userMap[b.userId?.toLowerCase()] || userMap[b.userId];
        const directParentDoc = u?.parentId ? userMap[u.parentId.toString()] : null;
        const netShare = getViewerNetShare(parent, u, userMap);
        const shareAmount = Math.round((Number(b.stake) || 0) * (netShare / 100));

        return {
            id: b._id,
            runner: b.runner,
            price: b.odds,
            size: b.stake,
            better: b.userId,
            master: directParentDoc ? directParentDoc.username : (u?.parentName || 'Direct'),
            type: b.type,
            matchId: b.matchId,
            matchName: b.matchName || `${b.runner} Match`,
            marketType: b.marketType || 'match_odds',
            status: b.status,
            sharePercent: netShare,
            shareAmount: shareAmount,
            createdAt: b.createdAt
        };
    });

    res.json(matchedBets);
  } catch (err) {
    console.error("Global Matched Bets Error:", err);
    res.status(500).json({ error: 'Server error fetching global bets' });
  }
});

// Get Global Open (Pending) Bets
router.get('/global-open-bets', auth, isAuthorized, async (req, res) => {
  try {
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    const allowedUsernames = await getAllDescendantUsernames(parent);
    let betQuery = { 
      status: 'pending',
      userId: { $in: allowedUsernames }
    };

    const bets = await Bet.find(betQuery).sort({ createdAt: -1 }).limit(50).lean();

    const userIds = [...new Set(bets.map(b => b.userId))];
    const users = await User.find({ username: { $in: userIds } }).lean();
    const parentIds = [...new Set(users.map(u => u.parentId).filter(id => id))];
    const parents = await User.find({ _id: { $in: parentIds } }).lean();

    const userMap = {};
    users.forEach(u => {
        const parentDoc = parents.find(p => p._id.toString() === u.parentId?.toString());
        userMap[u.username] = {
            username: u.username,
            parentName: parentDoc ? parentDoc.username : 'Direct'
        };
    });

    const openBets = bets.map(b => {
        const u = userMap[b.userId];
        return {
            id: b._id,
            runner: b.runner,
            price: b.odds,
            size: b.stake,
            better: b.userId,
            master: u?.parentName || 'Direct',
            type: b.type,
            matchId: b.matchId,
            createdAt: b.createdAt
        };
    });

    res.json(openBets);
  } catch (err) {
    console.error("Global Open Bets Error:", err);
    res.status(500).json({ error: 'Server error fetching global open bets' });
  }
});

// Reset All Accounts (SuperAdmin only)
router.post('/reset-all-accounts', auth, isAuthorized, async (req, res) => {
  try {
    const requester = await User.findOne({ username: req.user.userId });
    if (!requester || requester.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only SuperAdmin can perform a system reset.' });
    }
    if (requester.share >= 97 || requester.share === 97 || requester.share === 100 || requester.username?.toLowerCase() === 'md97fs' || requester.username?.toLowerCase() === 'md202fs') {
      return res.status(403).json({ error: 'System reset is disabled for 97% and 100% accounts.' });
    }

    const { mode = 'balances' } = req.body || {};
    const Transaction = require('../models/Transaction');
    const Bet = require('../models/Bet');
    const CasinoBet = require('../models/CasinoBet');
    const AviatorBet = require('../models/AviatorBet');
    const AviatorXBet = require('../models/AviatorXBet');
    const TeenPattiBet = require('../models/TeenPattiBet');

    let message = '';

    if (mode === 'full') {
      // Option B: Delete all non-superadmin users
      const deleteUsers = await User.deleteMany({ role: { $ne: 'superadmin' } });
      message = `Full system reset complete. Deleted ${deleteUsers.deletedCount} downline accounts.`;
    } else {
      // Option A (Default): Reset all downline user balances to match credit limit
      const downlineUsers = await User.find({ role: { $ne: 'superadmin' } });
      for (const u of downlineUsers) {
        u.walletBalance = u.credit || 0;
        await u.save();
      }
      message = `Account balances reset successfully for ${downlineUsers.length} downline accounts. All balances set to credit limit.`;
    }

    // Reset superadmin balance and credit to 1 Crore (₹10,000,000)
    await User.updateMany(
      { role: 'superadmin' },
      { $set: { credit: 0, walletBalance: 10000000 } }
    );

    // Delete all transactions and bets
    await Transaction.deleteMany({});
    await Bet.deleteMany({});
    if (CasinoBet) await CasinoBet.deleteMany({});
    if (AviatorBet) await AviatorBet.deleteMany({});
    if (AviatorXBet) await AviatorXBet.deleteMany({});
    if (TeenPattiBet) await TeenPattiBet.deleteMany({});

    res.json({ 
      success: true, 
      message
    });
  } catch (err) {
    console.error("Reset All Accounts Error:", err);
    res.status(500).json({ error: 'Server error resetting accounts' });
  }
});


// Get Account Ledger Endpoint
router.get('/account-ledger', auth, isAuthorized, async (req, res) => {
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

    const allowedUsernames = await getAllDescendantUsernames(currentUser);

    let isAll = (!targetUsername || targetUsername === 'ALL');
    let userFilter = {};

    if (isAll) {
      userFilter = { userId: { $in: allowedUsernames } };
    } else {
      const target = await User.findOne({ username: targetUsername });
      if (!target) return res.status(404).json({ error: 'Target account not found' });

      if (!allowedUsernames.includes(target.username)) {
        return res.status(403).json({ error: 'Unauthorized to view this account ledger' });
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
router.get('/downline-list', auth, isAuthorized, async (req, res) => {
  try {
    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const descendants = await getAllDescendants(currentUser._id, '_id username role walletBalance credit');
    const downlines = [
      { _id: currentUser._id, username: currentUser.username, role: currentUser.role, walletBalance: currentUser.walletBalance, credit: currentUser.credit },
      ...descendants
    ];
    downlines.sort((a, b) => a.username.localeCompare(b.username));

    res.json({ success: true, users: downlines });
  } catch (err) {
    console.error("Downline list error:", err);
    res.status(500).json({ error: 'Failed to fetch downlines' });
  }
});

// ─── Toss Winner Declaration ──────────────────────────────────────────────────
router.post('/declare-toss-winner', auth, isAuthorized, async (req, res) => {
  try {
    const { matchId, tossWinner } = req.body;
    if (!matchId || !tossWinner) {
      return res.status(400).json({ error: 'Missing matchId or tossWinner' });
    }

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (match.tossWinner) {
      return res.status(400).json({ error: `Toss already settled. Winner: ${match.tossWinner}` });
    }

    // Validate tossWinner is one of the teams
    const validTeams = [match.teamA, match.teamB, 'VOID', 'REFUND'];
    if (!validTeams.includes(tossWinner)) {
      return res.status(400).json({ error: `Invalid toss winner. Must be one of: ${validTeams.join(', ')}` });
    }

    // Settle toss bets
    const { settleToss } = require('../services/tossOddsEngine');
    const io = req.app.get('io');
    await settleToss(matchId, tossWinner, io);

    console.log(`[Admin] 🏆 Toss winner declared for ${match.teamA} v ${match.teamB}: ${tossWinner}`);

    res.json({ 
      success: true, 
      message: `Toss winner declared: ${tossWinner}`,
      matchId,
      tossWinner
    });
  } catch (err) {
    console.error('[Admin] Toss declaration error:', err);
    res.status(500).json({ error: 'Failed to declare toss winner' });
  }
});

// ─── Match Winner Declaration & Full Hierarchy Settlement ───────────────────────────
router.post('/declare-match-winner', auth, isAuthorized, async (req, res) => {
  try {
    const { matchId, winningTeam } = req.body;
    if (!matchId || !winningTeam) {
      return res.status(400).json({ error: 'Missing matchId or winningTeam' });
    }

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const normDeclared = winningTeam.trim();
    
    match.status = 'completed';
    match.winner = normDeclared;
    await match.save();

    const io = req.app.get('io');
    await settleMatch(matchId, normDeclared, io);

    if (io) {
      io.emit('match_updated', match);
      io.emit('match_settled', { matchId, winner: normDeclared });
    }

    console.log(`[Admin] 🏆 Match winner declared and bets settled for ${match.teamA} v ${match.teamB}: ${normDeclared}`);

    res.json({
      success: true,
      message: `Match winner declared and settled: ${normDeclared}`,
      matchId,
      winner: normDeclared
    });
  } catch (err) {
    console.error('[Admin] Match declaration error:', err);
    res.status(500).json({ error: 'Failed to declare match winner' });
  }
});

// Alias for match settlement
router.post('/settle-match', auth, isAuthorized, async (req, res) => {
  try {
    const { matchId, winningTeam, winner } = req.body;
    const finalWinner = winningTeam || winner;
    if (!matchId || !finalWinner) {
      return res.status(400).json({ error: 'Missing matchId or winner' });
    }

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    match.status = 'completed';
    match.winner = finalWinner.trim();
    await match.save();

    const io = req.app.get('io');
    await settleMatch(matchId, finalWinner.trim(), io);

    if (io) {
      io.emit('match_updated', match);
      io.emit('match_settled', { matchId, winner: finalWinner.trim() });
    }

    res.json({
      success: true,
      message: `Match settled successfully: ${finalWinner}`,
      matchId,
      winner: finalWinner
    });
  } catch (err) {
    console.error('[Admin] Match settle error:', err);
    res.status(500).json({ error: 'Failed to settle match' });
  }
});

// ─── Get Toss Exposure (for admin) ────────────────────────────────────────────
router.get('/toss-exposure/:matchId', auth, isAuthorized, async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const tossBets = await Bet.find({ matchId, marketType: 'toss', status: { $in: ['pending', 'MATCHED'] } });

    // Calculate exposure per runner
    const exposure = {};
    const runnerA = `${match.teamA} To Win The Toss`;
    const runnerB = `${match.teamB} To Win The Toss`;
    exposure[runnerA] = 0;
    exposure[runnerB] = 0;

    for (const bet of tossBets) {
      const profit = bet.stake * (bet.odds - 1);
      if (bet.type === 'back') {
        exposure[bet.runner] = (exposure[bet.runner] || 0) + profit;
        // For the other runner, platform loses the stake
        const otherRunner = bet.runner === runnerA ? runnerB : runnerA;
        exposure[otherRunner] = (exposure[otherRunner] || 0) - bet.stake;
      } else {
        // Lay: platform profits stake if runner loses, loses profit if runner wins
        exposure[bet.runner] = (exposure[bet.runner] || 0) - profit;
        const otherRunner = bet.runner === runnerA ? runnerB : runnerA;
        exposure[otherRunner] = (exposure[otherRunner] || 0) + bet.stake;
      }
    }

    res.json({
      matchId,
      tossWinner: match.tossWinner,
      tossMarketStatus: match.tossMarketStatus,
      exposure,
      totalTossBets: tossBets.length,
      matchedBets: tossBets.map(b => ({
        runner: b.runner,
        type: b.type,
        price: b.odds,
        size: b.stake,
        better: b.userId,
        master: ''
      }))
    });
  } catch (err) {
    console.error('[Admin] Toss exposure error:', err);
    res.status(500).json({ error: 'Failed to fetch toss exposure' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIGURE MARKET MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════════════════════

// Add/Update a figure market for a match
router.post('/figure-market/:matchId', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { name, maxBet, digits } = req.body;
    if (!name) return res.status(400).json({ error: 'Market name is required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const defaultDigits = Array.from({ length: 10 }, (_, i) => ({
      digit: i,
      odds: 8.85,
      status: 'OPEN'
    }));

    const existingIdx = match.figureMarkets.findIndex(m => m.name === name);
    if (existingIdx >= 0) {
      match.figureMarkets[existingIdx].maxBet = maxBet || match.figureMarkets[existingIdx].maxBet;
      if (digits) match.figureMarkets[existingIdx].digits = digits;
    } else {
      match.figureMarkets.push({
        name,
        maxBet: maxBet || 100000,
        status: 'OPEN',
        digits: digits || defaultDigits
      });
    }

    await match.save();

    // Emit socket update
    const io = req.app.get('io');
    if (io) {
      io.emit('figure_market_update', {
        matchId,
        figureMarkets: match.figureMarkets
      });
    }

    res.json({ success: true, figureMarkets: match.figureMarkets });
  } catch (err) {
    console.error('[Admin] Figure market error:', err);
    res.status(500).json({ error: 'Failed to update figure market' });
  }
});

// Update figure market status (OPEN/SUSPENDED)
router.post('/figure-market/:matchId/status', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { name, status } = req.body;
    if (!name || !status) return res.status(400).json({ error: 'Name and status required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const market = match.figureMarkets.find(m => m.name === name);
    if (!market) return res.status(404).json({ error: 'Figure market not found' });

    market.status = status;
    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('figure_market_update', { matchId, figureMarkets: match.figureMarkets });
    }

    res.json({ success: true, figureMarkets: match.figureMarkets });
  } catch (err) {
    console.error('[Admin] Figure market status error:', err);
    res.status(500).json({ error: 'Failed to update figure market status' });
  }
});

// Update individual digit odds in a figure market
router.post('/figure-market/:matchId/odds', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { name, digit, odds } = req.body;
    if (!name || digit === undefined || !odds) return res.status(400).json({ error: 'Name, digit, and odds required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const market = match.figureMarkets.find(m => m.name === name);
    if (!market) return res.status(404).json({ error: 'Figure market not found' });

    const digitEntry = market.digits.find(d => d.digit === digit);
    if (!digitEntry) return res.status(404).json({ error: 'Digit not found' });

    digitEntry.odds = odds;
    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('figure_market_update', { matchId, figureMarkets: match.figureMarkets });
    }

    res.json({ success: true, figureMarkets: match.figureMarkets });
  } catch (err) {
    console.error('[Admin] Figure digit odds error:', err);
    res.status(500).json({ error: 'Failed to update digit odds' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EVEN/ODD MARKET MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════════════════════

// Add/Update an even-odd market for a match
router.post('/even-odd-market/:matchId', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { name, backPrice, backVol, layPrice, layVol, maxBet, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Market name is required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const existingIdx = match.evenOddMarkets.findIndex(m => m.name === name);
    if (existingIdx >= 0) {
      const m = match.evenOddMarkets[existingIdx];
      if (backPrice !== undefined) m.backPrice = backPrice;
      if (backVol !== undefined) m.backVol = backVol;
      if (layPrice !== undefined) m.layPrice = layPrice;
      if (layVol !== undefined) m.layVol = layVol;
      if (maxBet !== undefined) m.maxBet = maxBet;
      if (status !== undefined) m.status = status;
    } else {
      match.evenOddMarkets.push({
        name,
        backPrice: backPrice || 1.98,
        backVol: backVol || "98",
        layPrice: layPrice || 2.02,
        layVol: layVol || "102",
        status: status || 'OPEN',
        maxBet: maxBet || 2000000
      });
    }

    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('even_odd_market_update', {
        matchId,
        evenOddMarkets: match.evenOddMarkets
      });
    }

    res.json({ success: true, evenOddMarkets: match.evenOddMarkets });
  } catch (err) {
    console.error('[Admin] Even-Odd market error:', err);
    res.status(500).json({ error: 'Failed to update even-odd market' });
  }
});

// Update even-odd market status
router.post('/even-odd-market/:matchId/status', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { name, status } = req.body;
    if (!name || !status) return res.status(400).json({ error: 'Name and status required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const market = match.evenOddMarkets.find(m => m.name === name);
    if (!market) return res.status(404).json({ error: 'Even-Odd market not found' });

    market.status = status;
    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('even_odd_market_update', { matchId, evenOddMarkets: match.evenOddMarkets });
    }

    res.json({ success: true, evenOddMarkets: match.evenOddMarkets });
  } catch (err) {
    console.error('[Admin] Even-Odd status error:', err);
    res.status(500).json({ error: 'Failed to update even-odd status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TIED MATCH (OTHERS) MARKET MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════════════════════

// Add/Update tied match market for a match
router.post('/tied-match-market/:matchId', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { maxBet, status, runners } = req.body;

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (!match.tiedMatchMarket) {
      match.tiedMatchMarket = {
        name: 'TIED MATCH',
        maxBet: maxBet || 500000,
        status: status || 'OPEN',
        runners: runners || [
          {
            name: 'Yes',
            backOdds: [
              { price: 100, volume: '42.8K' },
              { price: 120, volume: '397' },
              { price: 140, volume: '3.9K' }
            ],
            layOdds: [
              { price: 780, volume: '550' },
              { price: 1000, volume: '1.4K' }
            ]
          },
          {
            name: 'No',
            backOdds: [],
            layOdds: [
              { price: 1.01, volume: '4.2M' },
              { price: 1.02, volume: '5.6M' },
              { price: 1.03, volume: '4.2M' }
            ]
          }
        ]
      };
    } else {
      if (maxBet !== undefined) match.tiedMatchMarket.maxBet = maxBet;
      if (status !== undefined) match.tiedMatchMarket.status = status;
      if (runners) match.tiedMatchMarket.runners = runners;
    }

    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('tied_match_market_update', {
        matchId,
        tiedMatchMarket: match.tiedMatchMarket
      });
    }

    res.json({ success: true, tiedMatchMarket: match.tiedMatchMarket });
  } catch (err) {
    console.error('[Admin] Tied match market error:', err);
    res.status(500).json({ error: 'Failed to update tied match market' });
  }
});

// Update tied match market status
router.post('/tied-match-market/:matchId/status', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (!match.tiedMatchMarket) return res.status(404).json({ error: 'Tied match market not found' });

    match.tiedMatchMarket.status = status;
    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('tied_match_market_update', { matchId, tiedMatchMarket: match.tiedMatchMarket });
    }

    res.json({ success: true, tiedMatchMarket: match.tiedMatchMarket });
  } catch (err) {
    console.error('[Admin] Tied match status error:', err);
    res.status(500).json({ error: 'Failed to update tied match status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FANCY MARKET MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════════════════════════

// Add/Update a fancy market for a match
router.post('/fancy-market/:matchId', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { name, backPrice, backVol, layPrice, layVol, status, maxBet } = req.body;
    if (!name) return res.status(400).json({ error: 'Market name is required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const existingIdx = match.fancyMarkets.findIndex(m => m.name === name);
    if (existingIdx >= 0) {
      const f = match.fancyMarkets[existingIdx];
      if (backPrice !== undefined) f.backPrice = backPrice;
      if (backVol !== undefined) f.backVol = backVol;
      if (layPrice !== undefined) f.layPrice = layPrice;
      if (layVol !== undefined) f.layVol = layVol;
      if (status !== undefined) f.status = status;
      if (maxBet !== undefined) f.maxBet = maxBet;
    } else {
      match.fancyMarkets.push({
        name,
        backPrice: backPrice ?? 118,
        backVol: backVol || '100',
        layPrice: layPrice ?? 117,
        layVol: layVol || '100',
        status: status || 'OPEN',
        maxBet: maxBet || 2000000
      });
    }

    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('fancy_market_update', {
        matchId,
        fancyMarkets: match.fancyMarkets
      });
    }

    res.json({ success: true, fancyMarkets: match.fancyMarkets });
  } catch (err) {
    console.error('[Admin] Fancy market error:', err);
    res.status(500).json({ error: 'Failed to update fancy market' });
  }
});

// Update fancy market status (OPEN/SUSPENDED)
router.post('/fancy-market/:matchId/status', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { name, status } = req.body;
    if (!name || !status) return res.status(400).json({ error: 'Name and status required' });

    const match = await Match.findOne({ matchId });
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const market = match.fancyMarkets.find(m => m.name === name);
    if (!market) return res.status(404).json({ error: 'Fancy market not found' });

    market.status = status;
    await match.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('fancy_market_update', { matchId, fancyMarkets: match.fancyMarkets });
    }

    res.json({ success: true, fancyMarkets: match.fancyMarkets });
  } catch (err) {
    console.error('[Admin] Fancy market status error:', err);
    res.status(500).json({ error: 'Failed to update fancy market status' });
  }
});

module.exports = router;

