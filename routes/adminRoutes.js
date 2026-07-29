const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Match = require('../models/Match');
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const AviatorBet = require('../models/AviatorBet');
const TeenPattiBet = require('../models/TeenPattiBet');
const AviatorXBet = require('../models/AviatorXBet');
const auth = require('../middleware/auth');

// Middleware to check if user is Authorized (SuperAdmin, Admin, SuperMaster or Master)
const isAuthorized = (req, res, next) => {
  const authorizedRoles = ['superadmin', 'admin', 'supermaster', 'master'];
  if (authorizedRoles.includes(req.user.role)) {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Requires Authorized role.' });
  }
};

// Helper function to calculate Client Net P/L
async function calculateUserClientPL(user) {
  let pl = 0;
  if (user.role === 'user') {
    const winStatuses = ['won', 'WIN', 'WON', 'win'];
    const loseStatuses = ['lost', 'LOSE', 'LOST', 'lose'];

    const [cricket, casino, aviator, teenPatti, aviatorX, settlements] = await Promise.all([
      Bet.find({ userId: user.username, status: { $in: [...winStatuses, ...loseStatuses] } }).lean(),
      CasinoBet.find({ userId: user.username, status: { $in: [...winStatuses, ...loseStatuses] } }).lean(),
      AviatorBet.find({ userId: user.username, status: { $in: [...winStatuses, ...loseStatuses] } }).lean(),
      TeenPattiBet.find({ userId: user.username, status: { $in: [...winStatuses, ...loseStatuses] } }).lean(),
      AviatorXBet.find({ userId: user.username, status: { $in: [...winStatuses, ...loseStatuses] } }).lean(),
      Transaction.find({ userId: user.username, type: 'SETTLEMENT' }).lean()
    ]);

    cricket.forEach(b => {
      const stake = b.stake || b.amount || 0;
      if (winStatuses.includes(b.status)) pl += ((b.payout || (stake * (b.odds || 2.0))) - stake);
      else if (loseStatuses.includes(b.status)) pl -= stake;
    });

    casino.forEach(b => {
      const amt = b.amount || b.stake || 0;
      if (winStatuses.includes(b.status)) pl += (b.winAmount ? (b.winAmount - amt) : (amt * ((b.odds || 2.0) - 1) * 0.95));
      else if (loseStatuses.includes(b.status)) pl -= amt;
    });

    aviator.forEach(b => {
      const stake = b.stake || b.amount || 0;
      if (winStatuses.includes(b.status)) pl += ((b.payout || 0) - stake);
      else if (loseStatuses.includes(b.status)) pl -= stake;
    });

    teenPatti.forEach(b => {
      const amt = b.amount || b.stake || 0;
      if (winStatuses.includes(b.status)) pl += (b.payout ? (b.payout - amt) : (b.winAmount ? (b.winAmount - amt) : (amt * 0.95)));
      else if (loseStatuses.includes(b.status)) pl -= amt;
    });

    aviatorX.forEach(b => {
      const stake = b.stake || b.amount || 0;
      if (winStatuses.includes(b.status)) pl += ((b.payout || 0) - stake);
      else if (loseStatuses.includes(b.status)) pl -= stake;
    });

    settlements.forEach(s => {
      pl += (s.amount || 0);
    });
  } else {
    const childUsers = await User.find({ parentId: user._id }).lean();
    for (const child of childUsers) {
      pl += await calculateUserClientPL(child);
    }
    const ownSettlements = await Transaction.find({ userId: user.username, type: 'SETTLEMENT' }).lean();
    ownSettlements.forEach(s => {
      pl += (s.amount || 0);
    });
  }
  return Math.round(pl * 100) / 100;
}


// Create Downline User (Admin, SuperMaster, Master, or Bettor)
router.post('/create-user', auth, isAuthorized, async (req, res) => {
  try {
    const { username, password, role, initialBalance, balanceType, type, share } = req.body;
    const selectedBalanceType = balanceType || type || 'cash';

    // Validation
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Share Validation (0-85, since 15% is reserved for Book)
    const masterShare = parseFloat(share) || 0;
    if (masterShare < 0 || masterShare > 85) {
      return res.status(400).json({ error: 'Share must be between 0 and 85 (15% is reserved for Book)' });
    }

    // Role restriction logic
    if (req.user.role === 'master' && role !== 'user') {
      return res.status(403).json({ error: 'Masters can only create Bettors' });
    }
    if (req.user.role === 'supermaster' && !['master', 'user'].includes(role)) {
      return res.status(403).json({ error: 'SuperMasters can only create Masters or Bettors' });
    }
    if (req.user.role === 'admin' && !['supermaster', 'master', 'user'].includes(role)) {
      return res.status(403).json({ error: 'Admins can only create SuperMasters, Masters, or Bettors' });
    }

    const lowerUsername = username.toLowerCase();
    let existingUser = await User.findOne({ username: lowerUsername });
    if (existingUser) return res.status(400).json({ error: 'Username already exists' });

    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'Parent user not found' });

    // Share Hierarchy Validation
    if (['admin', 'supermaster'].includes(req.user.role) && ['supermaster', 'master'].includes(role)) {
      if (masterShare >= parent.share) {
        return res.status(400).json({ error: `Downline share must be less than your share (${parent.share}%)` });
      }
    }

    const balance = parseFloat(initialBalance) || 0;
    if (isNaN(balance) || balance < 0) {
      return res.status(400).json({ error: 'Invalid initial balance' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    if (balance > 0) {
      // Atomic deduction from parent's walletBalance for ALL roles (including SuperAdmin) for cash & credit
      const updatedParent = await User.findOneAndUpdate(
        { _id: parent._id, walletBalance: { $gte: balance } },
        { $inc: { walletBalance: -balance } },
        { new: true }
      );

      if (!updatedParent) {
        return res.status(400).json({ 
          error: `Insufficient wallet balance in your account (${parent.username}). Available: ₹${parent.walletBalance.toLocaleString('en-IN')}, requested: ₹${balance.toLocaleString('en-IN')}` 
        });
      }

      parent.walletBalance = updatedParent.walletBalance;
    }

    let newUser;

    if (selectedBalanceType === 'credit') {
      newUser = new User({
        username: lowerUsername,
        password: hashedPassword,
        role,
        share: (role === 'master' || role === 'admin') ? masterShare : 0,
        parentId: parent._id,
        walletBalance: balance,
        credit: balance
      });

      if (balance > 0) {
        const newTransaction = new Transaction({
          userId: lowerUsername,
          amount: balance,
          type: 'LOAD_CREDIT',
          category: 'credit',
          description: `Initial Credit Received from ${parent.role} ${parent.username} (Credit)`,
          performedBy: parent.username
        });
        await newTransaction.save();

        const parentTx = new Transaction({
          userId: parent.username,
          amount: -balance,
          type: 'CREDIT_GIVEN',
          category: 'credit',
          downline: lowerUsername,
          description: `Initial Credit Issued to ${lowerUsername} (Credit)`,
          performedBy: parent.username
        });
        await parentTx.save();
      }
    } else {
      // Default: Cash Deposit
      if (balance > 0) {
        const parentTx = new Transaction({
          userId: parent.username,
          amount: -balance,
          type: 'CASH_DEPOSIT',
          category: 'wallet',
          downline: lowerUsername,
          description: `Initial Cash Deposit to ${lowerUsername}`,
          performedBy: parent.username
        });
        await parentTx.save();
      }

      newUser = new User({
        username: lowerUsername,
        password: hashedPassword,
        role,
        share: (role === 'master' || role === 'admin') ? masterShare : 0,
        parentId: parent._id,
        walletBalance: balance,
        credit: 0
      });

      if (balance > 0) {
        const newTransaction = new Transaction({
          userId: lowerUsername,
          amount: balance,
          type: 'LOAD_BALANCE',
          category: 'wallet',
          description: `Initial Cash Deposit from ${parent.role} ${parent.username}`,
          performedBy: parent.username
        });
        await newTransaction.save();
      }
    }

    await newUser.save();
    res.json({ 
      success: true, 
      user: { 
        username: newUser.username, 
        role: newUser.role, 
        balance: newUser.walletBalance,
        credit: newUser.credit
      },
      parentBalance: parent.walletBalance
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Downline Users with sub-user counts and Client P/L (Supports optional ?username= for hierarchy drill-down)
router.get('/downline', auth, isAuthorized, async (req, res) => {
  try {
    const loggedInUser = await User.findOne({ username: req.user.userId });
    if (!loggedInUser) return res.status(404).json({ error: 'User not found' });

    let targetParent = loggedInUser;
    const { username } = req.query;

    if (username && username.trim() !== '' && username.trim().toLowerCase() !== loggedInUser.username.toLowerCase()) {
      const requestedUser = await User.findOne({ username: username.trim().toLowerCase() });
      if (!requestedUser) {
        return res.status(404).json({ error: 'Requested parent user not found' });
      }

      // Authorization check: Is requestedUser in loggedInUser's downline tree or is loggedInUser superadmin?
      if (loggedInUser.role !== 'superadmin') {
        let curr = requestedUser;
        let isDescendant = false;
        while (curr && curr.parentId) {
          if (curr.parentId.toString() === loggedInUser._id.toString()) {
            isDescendant = true;
            break;
          }
          curr = await User.findById(curr.parentId).lean();
        }
        if (!isDescendant) {
          return res.status(403).json({ error: 'Access denied: Target user is not in your downline' });
        }
      }
      targetParent = requestedUser;
    }

    const users = await User.find({ parentId: targetParent._id }).select('-password').sort({ createdAt: -1 }).lean();
    
    // Efficiently get counts for all found users
    const userIds = users.map(u => u._id);
    const counts = await User.aggregate([
      { $match: { parentId: { $in: userIds } } },
      { $group: { _id: "$parentId", count: { $sum: 1 } } }
    ]);

    const countMap = {};
    counts.forEach(c => countMap[c._id.toString()] = c.count);

    const usersWithCountsAndPL = await Promise.all(users.map(async u => {
      const clientPL = await calculateUserClientPL(u);
      return {
        ...u,
        downlineCount: countMap[u._id.toString()] || 0,
        clientPL
      };
    }));

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
      ancestor = await User.findById(ancestor.parentId).lean();
    }

    // Calculate parent's own Client P/L for the summary row
    const parentClientPL = await calculateUserClientPL(targetParent);

    // Return object with users list, target parent info and breadcrumbs
    res.json({
      users: usersWithCountsAndPL,
      parentInfo: {
        username: targetParent.username,
        role: targetParent.role,
        _id: targetParent._id,
        credit: targetParent.credit || 0,
        walletBalance: targetParent.walletBalance || 0,
        clientPL: parentClientPL
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
        amount: -addAmount,
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

      // Calculate credit deduction (deduct from credit limit if credit exists)
      const creditDeduction = availableCredit > 0 ? Math.min(withdrawAmount, availableCredit) : 0;

      const updatedTarget = await User.findOneAndUpdate(
        { _id: target._id },
        { $inc: { walletBalance: -withdrawAmount, credit: -creditDeduction } },
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
        amount: withdrawAmount,
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
      target = await User.findOne({ username: targetUsername });
    } else {
      target = await User.findOne({ username: targetUsername, parentId: parent._id });
    }

    if (!target) return res.status(404).json({ error: 'Downline user not found' });

    // Restriction: Master can only settle Bettors
    if (req.user.role === 'master' && target.role !== 'user') {
      return res.status(403).json({ error: 'Masters can only settle Bettors' });
    }

    // Calculate current P/L to determine settlement direction
    const clientPL = await calculateUserClientPL(target);
    const settleAmount = Math.abs(rawAmount);

    const isTargetCredit = (clientPL < 0 || (clientPL === 0 && rawAmount > 0));

    const desc = description && description.trim() !== '' ? description.trim() : 'P/L to Cash transfer';

    // Double entry transactions:
    // Target user transaction
    const targetTx = new Transaction({
      userId: target.username,
      amount: isTargetCredit ? settleAmount : -settleAmount,
      type: 'SETTLEMENT',
      category: 'wallet',
      description: desc,
      downline: parent.username,
      performedBy: parent.username
    });
    await targetTx.save();

    // Parent user transaction for ledger and final sheet
    const parentTx = new Transaction({
      userId: parent.username,
      amount: isTargetCredit ? -settleAmount : settleAmount,
      type: 'SETTLEMENT',
      category: 'wallet',
      downline: target.username,
      description: desc,
      performedBy: parent.username
    });
    await parentTx.save();

    res.json({
      success: true,
      message: 'Account settled successfully',
      newTargetBalance: target.walletBalance,
      parentBalance: parent.walletBalance
    });
  } catch (err) {
    console.error("Settle Account Error:", err);
    res.status(500).json({ error: 'Server error settling account' });
  }
});


// Update Downline User Detail (Share, Password, etc.)
router.post('/update-user', auth, isAuthorized, async (req, res) => {
  try {
    const { targetUsername, share, newPassword } = req.body;
    const parent = await User.findOne({ username: req.user.userId });
    
    const target = await User.findOne({ username: targetUsername, parentId: parent._id });
    if (!target) return res.status(404).json({ error: 'User not found in downline' });

    // Restriction: Master can only edit Bettors
    if (req.user.role === 'master' && target.role !== 'user') {
      return res.status(403).json({ error: 'Masters can only edit Bettors' });
    }

    // Share is immutable for admin and master roles after creation
    if ((target.role === 'admin' || target.role === 'master') && share !== undefined) {
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

    await target.save();
    res.json({ success: true, user: { username: target.username, share: target.share, role: target.role } });
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

    // SuperAdmin can view any user statement; Admin/Master can view downline users or self
    if (req.user.role !== 'superadmin') {
      const currentUser = await User.findOne({ username: req.user.userId });
      if (!currentUser) return res.status(403).json({ error: 'Access denied' });
      
      // Check if target is equal to currentUser or child/downline
      const isDirectChild = target.parentId && target.parentId.toString() === currentUser._id.toString();
      const isSelf = target.username === currentUser.username;
      if (!isDirectChild && !isSelf) {
        // If not direct child, check if target's parent is created by currentUser
        const targetParent = await User.findById(target.parentId);
        const isIndirectChild = targetParent && targetParent.parentId && targetParent.parentId.toString() === currentUser._id.toString();
        if (!isIndirectChild) {
          return res.status(403).json({ error: 'Access denied: User not in downline' });
        }
      }
    }

    const transactions = await Transaction.find({ userId: username }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (err) {
    console.error('Error fetching user statement:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Dashboard Stats (Match-wise exposure)
router.get('/dashboard-stats', auth, isAuthorized, async (req, res) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [parent, activeMatches] = await Promise.all([
      User.findOne({ username: req.user.userId }),
      Match.find({ 
        $or: [
          { status: { $in: ['scheduled', 'live', 'upcoming'] } },
          { status: 'resulted', updatedAt: { $gte: twentyFourHoursAgo } }
        ]
      }).select('matchId teamA teamB status backOddsA backOddsB layOddsA layOddsB').lean()
    ]);
    if (!parent) return res.status(404).json({ error: 'User not found' });
    
    const matchIds = activeMatches.map(m => m.matchId);

    // 2. Prepare Match Stake Query (Include WON/LOST for resulted matches)
    let matchStatsQuery = { 
      matchId: { $in: matchIds }, 
      status: { $in: ['MATCHED', 'pending', 'WIN', 'LOSE', 'won', 'lost'] } 
    };
    
    if (req.user.role === 'master') {
      const downlineUsers = await User.find({ parentId: parent._id }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      matchStatsQuery.userId = { $in: usernames };
    } else if (req.user.role === 'admin') {
      const masters = await User.find({ parentId: parent._id }).select('_id');
      const masterIds = masters.map(m => m._id);
      const downlineUsers = await User.find({ $or: [{ parentId: parent._id }, { parentId: { $in: masterIds } }] }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      matchStatsQuery.userId = { $in: usernames };
    }

    const bets = await Bet.find(matchStatsQuery).lean();

    // Map users for share calculation
    const uniqueUserIds = [...new Set(bets.map(b => b.userId))];
    const betUsers = await User.find({ username: { $in: uniqueUserIds } }).lean();
    
    // Get immediate parents (Masters)
    const immediateParentIds = [...new Set(betUsers.filter(u => u.parentId).map(u => u.parentId))];
    const immediateParents = await User.find({ _id: { $in: immediateParentIds } }).lean();
    
    // Get their parents (Admins)
    const adminIds = [...new Set(immediateParents.filter(u => u.parentId).map(u => u.parentId))];
    const adminUsers = await User.find({ _id: { $in: adminIds } }).lean();
    
    const allParents = [...immediateParents, ...adminUsers];
    
    const userMap = {};
    betUsers.forEach(u => {
      const parent = allParents.find(p => p._id.toString() === u.parentId?.toString());
      userMap[u.username] = {
        ...u,
        parentShare: parent ? parent.share : 0
      };
    });

    const results = [];
    for (const m of activeMatches) {
      const runners = [m.teamA, m.teamB];
      const matchBets = bets.filter(b => b.matchId === m.matchId);
      const isResulted = m.status === 'resulted';

      runners.forEach(r => {
        let exposure = 0;
        let totalStake = 0;
        const normalizedR = r?.trim().toLowerCase();

        // 3% Platform Commission Logic: 
        // If user wins, house takes 3% of their net win. 
        // This 3% is added to the house profit and distributed.
        
        matchBets.forEach(b => {
          const { runner, odds, stake, type, userId, status } = b;
          const normalizedRunner = runner?.trim().toLowerCase();
          
          // Get the robust hierarchical net share
          const getNetShare = () => {
            const user = userMap[userId];
            if (!user) return 0;

            let mShare = 0;
            let aShare = 0;

            // Find Master and Admin in hierarchy
            let master = allParents.find(p => p._id.toString() === user.parentId?.toString() && p.role === 'master');
            if (master) {
                mShare = master.share || 0;
                let admin = allParents.find(p => p._id.toString() === master.parentId?.toString() && p.role === 'admin');
                if (admin) aShare = admin.share || 0;
            } else {
                let admin = allParents.find(p => p._id.toString() === user.parentId?.toString() && p.role === 'admin');
                if (admin) aShare = admin.share || 0;
            }

            // Direct share model: each entity gets their full share %
            if (req.user.role === 'master') return mShare;
            if (req.user.role === 'admin') return aShare;
            if (req.user.role === 'superadmin') return 85 - aShare - mShare;
            return 0;
          };

          const netShare = getNetShare();
          const adminStake = stake * (netShare / 100);

          if (normalizedRunner === normalizedR) {
            totalStake += adminStake;
          }

          const COMMISSION_RATE = 0.05;

          if (isResulted) {
             if (normalizedRunner === normalizedR) {
                if (status.toUpperCase() === 'WIN') {
                    // House loses (Odds-1)*Stake, but gains 3% commission on that win
                    const userWin = (odds - 1) * stake;
                    const commission = userWin * COMMISSION_RATE;
                    exposure -= (userWin - commission) * (netShare / 100);
                } else if (status.toUpperCase() === 'LOSE') {
                    // House wins Stake
                    exposure += adminStake;
                }
             } else {
                if (status.toUpperCase() === 'WIN') {
                    // House wins Stake from losing bettor (who bet on OTHER runner)
                    // Wait, if other runner won, then this runner lost.
                    // Bettor lost stake. House wins it.
                    exposure += adminStake;
                } else if (status.toUpperCase() === 'LOSE') {
                    // House loses to winning bettor (who bet on OTHER runner)
                    // But gains commission.
                    const userWin = (odds - 1) * stake;
                    const commission = userWin * COMMISSION_RATE;
                    exposure -= (userWin - commission) * (netShare / 100);
                }
             }
          } else {
            // Live match exposure calculation with commission projection
            if (type === 'back') {
              if (normalizedRunner === normalizedR) {
                  // If this runner wins, house loses user win - commission
                  const userWin = (odds - 1) * stake;
                  const commission = userWin * COMMISSION_RATE;
                  exposure -= (userWin - commission) * (netShare / 100);
              } else {
                  // If this runner wins, house wins the stake from the losing bet on other runner
                  exposure += adminStake;
              }
            } else { // lay
              if (normalizedRunner === normalizedR) {
                  // If this runner wins, house wins the liability (user loss)
                  exposure += (odds - 1) * adminStake;
              } else {
                  // If this runner wins, house loses the stake - commission
                  const userWin = stake;
                  const commission = userWin * COMMISSION_RATE;
                  exposure -= (userWin - commission) * (netShare / 100);
              }
            }
          }
        });

        results.push({
          name: r,
          matchName: `${m.teamA} v ${m.teamB}`,
          matchId: m.matchId,
          amount: exposure,
          totalStake: totalStake,
          isResulted: isResulted,
          back: normalizedR === m.teamA?.toLowerCase() ? m.backOddsA : m.backOddsB,
          lay: normalizedR === m.teamA?.toLowerCase() ? m.layOddsA : m.layOddsB,
          backStake: "0.0", // Placeholder or calculate if needed
          layStake: "0.0"
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

const { generateFinalSheet } = require('../services/finalSheetEngine');

// Get Final Sheet (Green/Red/Net Ledger - cumulative running totals or date filtered)
router.get('/final-sheet', auth, isAuthorized, async (req, res) => {
  try {
    const { date, month, year, reportType, startDate: sDate, endDate: eDate } = req.query;
    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const PLATFORM_FEE_RATE = 0.05; // 5% platform commission

    // 1. Fetch all betting-related share & cash transactions for the current user (Credit limit ops excluded)
    const types = ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'LOAD_BALANCE', 'WITHDRAW'];

    let allowedUsernames = [currentUser.username];
    if (currentUser.role === 'superadmin') {
      const allUsers = await User.find({}).select('username').lean();
      allowedUsernames = allUsers.map(u => u.username);
    } else {
      const getDownlines = async (parentId) => {
        const children = await User.find({ parentId }).select('_id username').lean();
        let list = [...children];
        for (const child of children) {
          const sub = await getDownlines(child._id);
          list = [...list, ...sub];
        }
        return list;
      };
      const downlineUsers = await getDownlines(currentUser._id);
      allowedUsernames = [currentUser.username, ...downlineUsers.map(u => u.username)];
    }

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

    const txs = await Transaction.find(query).sort({ createdAt: -1 });

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
    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const types = ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'LOAD_BALANCE', 'WITHDRAW'];

    let allowedUsernames = [currentUser.username];
    if (currentUser.role === 'superadmin') {
      const allUsers = await User.find({}).select('username').lean();
      allowedUsernames = allUsers.map(u => u.username);
    } else {
      const getDownlines = async (parentId) => {
        const children = await User.find({ parentId }).select('_id username').lean();
        let list = [...children];
        for (const child of children) {
          const sub = await getDownlines(child._id);
          list = [...list, ...sub];
        }
        return list;
      };
      const downlineUsers = await getDownlines(currentUser._id);
      allowedUsernames = [currentUser.username, ...downlineUsers.map(u => u.username)];
    }

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

    const txs = await Transaction.find(query).sort({ createdAt: -1 });

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
          const saShare = Math.max(0, 85 - aShare - mShare);
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
  const saShare = Math.max(0, 85 - aShare - mShare);

  let sharePercent = 0;
  if (viewerRole === 'master') sharePercent = mShare;
  else if (viewerRole === 'admin') sharePercent = aShare;
  else if (viewerRole === 'superadmin') {
    if (tx.type === 'BOOK_SHARE') sharePercent = 15;
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
          const saShare = Math.max(0, 85 - aShare - mShare);
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
          const saShare = Math.max(0, 85 - aShare - mShare);
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
          const netProfit = profit * 0.95;
          betComm = profit * 0.05;
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
    if (req.user.role !== 'superadmin') {
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

    const result = await Transaction.deleteMany({
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
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only SuperAdmin can clear final sheet data' });
    }

    const result = await Transaction.deleteMany({
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
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only SuperAdmin can perform full system reset' });
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

    // 2. Reset SuperAdmin balance to 100 Crore (₹1,000,000,000)
    await User.updateMany({ role: 'superadmin' }, { $set: { walletBalance: 1000000000, credit: 0 } });

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
    let betQuery = { matchId, status: 'MATCHED' };
    
    const parent = await User.findOne({ username: req.user.userId });
    
    if (req.user.role === 'master') {
      const downlineUsers = await User.find({ parentId: parent._id }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      betQuery.userId = { $in: usernames };
    } else if (req.user.role === 'admin') {
      const masters = await User.find({ parentId: parent._id }).select('_id');
      const masterIds = masters.map(m => m._id);
      const downlineUsers = await User.find({ $or: [{ parentId: parent._id }, { parentId: { $in: masterIds } }] }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      betQuery.userId = { $in: usernames };
    }
    // Superadmin sees all bets

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

    // Helper to get net share for a specific admin on a specific user's bet
    const getAdminNetShare = (userId, requesterId, requesterRole) => {
        const user = users.find(u => u.username === userId);
        if (!user) return 0;

        // Trace the hierarchy: User -> ?Master -> ?Admin -> SuperAdmin
        let master = null;
        let admin = null;

        let currentParentId = user.parentId;
        while (currentParentId) {
            const parent = parents.find(p => p._id.toString() === currentParentId.toString());
            if (!parent) break;
            if (parent.role === 'master') master = parent;
            if (parent.role === 'admin') admin = parent;
            currentParentId = parent.parentId;
        }

        const mShare = master ? (master.share || 0) : 0;
        const aShare = admin ? (admin.share || 0) : 0;

        // Direct share model: each entity gets their full share %
        if (requesterRole === 'master') {
            return mShare;
        } else if (requesterRole === 'admin') {
            return aShare;
        } else if (requesterRole === 'superadmin') {
            // SuperAdmin gets 85% minus all child shares
            return 85 - aShare - mShare;
        }
        return 0;
    };

    const requester = await User.findOne({ username: req.user.userId });
    const requesterId = requester._id.toString();
    const requesterRole = requester.role;

    const COMMISSION_RATE = 0.05;

    // 4. Calculate Exposure for Requester
    const exposure = {};
    runners.forEach(r => exposure[r] = 0);

    bets.forEach(b => {
        const { runner, odds, stake, type, userId } = b;
        const netShare = getAdminNetShare(userId, requesterId, requesterRole);
        const adminStake = stake * (netShare / 100);
        
        runners.forEach(winRunner => {
            let adminProfit = 0;
            const normalizedRunner = runner?.trim().toLowerCase();
            const normalizedWinRunner = winRunner?.trim().toLowerCase();

            if (type === 'back') {
                if (normalizedRunner === normalizedWinRunner) {
                    // Bettor wins (Odds-1)*Stake. House loses it but gains 3% commission
                    const userWin = (odds - 1) * stake;
                    const commission = userWin * COMMISSION_RATE;
                    adminProfit = -(userWin - commission) * (netShare / 100);
                } else {
                    // Bettor loses Stake, Admin wins it proportional to share
                    adminProfit = adminStake;
                }
            } else { // lay
                if (normalizedRunner === normalizedWinRunner) {
                    // Bettor loses (Odds-1)*Stake (Liability). Admin wins it
                    adminProfit = (odds - 1) * adminStake;
                } else {
                    // Bettor wins Stake. Admin loses it but gains 3% commission
                    const userWin = stake;
                    const commission = userWin * COMMISSION_RATE;
                    adminProfit = -(userWin - commission) * (netShare / 100);
                }
            }
            exposure[winRunner] += adminProfit;
        });
    });

    // 5. Format Matched Bets for UI
    const matchedBets = bets.map(b => {
        const netShare = getAdminNetShare(b.userId, requesterId, requesterRole);
        const parentStake = b.stake * (netShare / 100);

        return {
            id: b._id,
            runner: b.runner,
            price: b.odds,
            size: b.stake,
            parentStake: Number(parentStake.toFixed(2)),
            better: b.userId,
            master: userMap[b.userId]?.parentName || 'Unknown',
            type: b.type
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
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    let betQuery = { status: { $in: ['MATCHED', 'pending'] } };
    
    if (req.user.role === 'master') {
      const downlineUsers = await User.find({ parentId: parent._id }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      betQuery.userId = { $in: usernames };
    } else if (req.user.role === 'admin') {
      const masters = await User.find({ parentId: parent._id }).select('_id');
      const masterIds = masters.map(m => m._id);
      const downlineUsers = await User.find({ $or: [{ parentId: parent._id }, { parentId: { $in: masterIds } }] }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      betQuery.userId = { $in: usernames };
    }

    // Get 50 most recent matched bets
    const bets = await Bet.find(betQuery).sort({ createdAt: -1 }).limit(50).lean();

    // Map user data
    const userIds = [...new Set(bets.map(b => b.userId))];
    const users = await User.find({ username: { $in: userIds } }).lean();
    const parentIds = [...new Set(users.map(u => u.parentId).filter(id => id))];
    const parents = await User.find({ _id: { $in: parentIds } }).lean();

    const userMap = {};
    users.forEach(u => {
        const parentDoc = parents.find(p => p._id.toString() === u.parentId?.toString());
        userMap[u.username.toLowerCase()] = {
            username: u.username,
            parentName: parentDoc ? parentDoc.username : 'Direct'
        };
    });

    const matchedBets = bets.map(b => {
        const u = userMap[b.userId?.toLowerCase()];
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

    let betQuery = { status: 'pending' };
    
    if (req.user.role === 'master') {
      const downlineUsers = await User.find({ parentId: parent._id }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      betQuery.userId = { $in: usernames };
    } else if (req.user.role === 'admin') {
      const masters = await User.find({ parentId: parent._id }).select('_id');
      const masterIds = masters.map(m => m._id);
      const downlineUsers = await User.find({ $or: [{ parentId: parent._id }, { parentId: { $in: masterIds } }] }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      betQuery.userId = { $in: usernames };
    }

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
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only SuperAdmin can perform a system reset.' });
    }

    const { mode = 'balances' } = req.body || {};

    const User = require('../models/User');
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

    // Reset superadmin balance and credit
    await User.updateMany(
      { role: 'superadmin' },
      { $set: { credit: 0, walletBalance: 1000000000, share: 85 } }
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

    let isAll = (!targetUsername || targetUsername === 'ALL');
    let userFilter = {};

    if (isAll) {
      if (currentUser.role === 'superadmin') {
        userFilter = {};
      } else {
        const downlines = await User.find({ parentId: currentUser._id }, 'username');
        const downlineNames = downlines.map(u => u.username);
        downlineNames.push(currentUser.username);
        userFilter = { userId: { $in: downlineNames } };
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
router.get('/downline-list', auth, isAuthorized, async (req, res) => {
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


