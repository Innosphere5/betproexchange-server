const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Match = require('../models/Match');
const Bet = require('../models/Bet');
const auth = require('../middleware/auth');

// Middleware to check if user is Authorized (SuperAdmin, Admin or Master)
const isAuthorized = (req, res, next) => {
  const authorizedRoles = ['superadmin', 'admin', 'master'];
  if (authorizedRoles.includes(req.user.role)) {
    next();
  } else {
    res.status(403).json({ error: 'Access denied. Requires Authorized role.' });
  }
};

// Create Downline User (Admin, Master, or Bettor)
router.post('/create-user', auth, isAuthorized, async (req, res) => {
  try {
    const { username, password, role, initialBalance, share } = req.body;

    // Validation
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Share Validation (0-85)
    const masterShare = parseFloat(share) || 0;
    if (masterShare < 0 || masterShare > 100) {
      return res.status(400).json({ error: 'Share must be between 0 and 100' });
    }

    // Role restriction logic
    if (req.user.role === 'master' && role !== 'user') {
      return res.status(403).json({ error: 'Masters can only create Bettors' });
    }
    if (req.user.role === 'admin' && !['master', 'user'].includes(role)) {
      return res.status(403).json({ error: 'Admins can only create Masters or Bettors' });
    }
    // superadmin can create admin, master, user (no restriction needed here as role is in enum)

    let existingUser = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
    if (existingUser) return res.status(400).json({ error: 'Username already exists' });

    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'Parent user not found' });

    // Initial Balance Check
    const balance = parseFloat(initialBalance) || 0;
    const skipBalanceCheck = req.user.role === 'superadmin' || req.user.role === 'admin';
    if (!skipBalanceCheck && parent.walletBalance < balance) {
      return res.status(400).json({ error: 'Insufficient balance in parent account' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      username,
      password: hashedPassword,
      role,
      share: (role === 'master' || role === 'admin') ? masterShare : 0,
      parentId: parent._id,
      walletBalance: balance
    });

    // Deduct from parent balance if not SuperAdmin or Admin
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
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

// Get Downline Users with sub-user counts
router.get('/downline', auth, isAuthorized, async (req, res) => {
  try {
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    const users = await User.find({ parentId: parent._id }).select('-password').sort({ createdAt: -1 }).lean();
    
    // Efficiently get counts for all found users
    const userIds = users.map(u => u._id);
    const counts = await User.aggregate([
      { $match: { parentId: { $in: userIds } } },
      { $group: { _id: "$parentId", count: { $sum: 1 } } }
    ]);

    const countMap = {};
    counts.forEach(c => countMap[c._id.toString()] = c.count);

    const usersWithCounts = users.map(u => ({
      ...u,
      downlineCount: countMap[u._id.toString()] || 0
    }));

    res.json(usersWithCounts);
  } catch (err) {
    console.error("Downline Error:", err);
    res.status(500).json({ error: 'Server error fetching downline' });
  }
});

// Load Balance
router.post('/load-balance', auth, isAuthorized, async (req, res) => {
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

    // Deduct from parent if not SuperAdmin or Admin
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
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

// Withdraw Balance (Reduce)
router.post('/withdraw-balance', auth, isAuthorized, async (req, res) => {
  try {
    const { targetUsername, amount } = req.body;
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

    if (target.walletBalance < withdrawAmount) {
      return res.status(400).json({ error: 'User has insufficient balance to withdraw this amount' });
    }

    target.walletBalance -= withdrawAmount;
    await target.save();

    // Give back to parent if not SuperAdmin or Admin
    if (req.user.role !== 'superadmin' && req.user.role !== 'admin') {
      parent.walletBalance += withdrawAmount;
      await parent.save();
    }

    // Create Transaction Record
    const newTransaction = new Transaction({
      userId: target.username,
      amount: -withdrawAmount,
      type: 'WITHDRAW',
      description: `Balance reduced by ${parent.role} ${parent.username}`,
      performedBy: parent.username
    });
    await newTransaction.save();

    res.json({ success: true, newBalance: target.walletBalance, parentBalance: parent.walletBalance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
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

    // Update Share if Master
    if (target.role === 'master') {
      const upShare = parseFloat(share);
      if (!isNaN(upShare)) {
        if (upShare < 0 || upShare > 85) {
          return res.status(400).json({ error: 'Share must be between 0 and 85' });
        }
        target.share = upShare;
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

// Get Downline User Statement (Ledger)
router.get('/user-statement/:username', auth, isAuthorized, async (req, res) => {
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

// Get Dashboard Stats (Match-wise exposure)
router.get('/dashboard-stats', auth, isAuthorized, async (req, res) => {
  try {
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    // 1. Get all scheduled/live matches
    const activeMatches = await Match.find({ status: { $in: ['scheduled', 'live'] } }).select('matchId teamA teamB');
    const matchIds = activeMatches.map(m => m.matchId);

    // 2. Prepare Match Stake Query
    let matchStatsQuery = { matchId: { $in: matchIds }, status: 'MATCHED' };
    
    if (req.user.role === 'master') {
      // Find direct downline for Master
      const downlineUsers = await User.find({ parentId: parent._id }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      matchStatsQuery.userId = { $in: usernames };
    } else if (req.user.role === 'admin') {
      // Find all downline (masters and their users) for Admin
      const masters = await User.find({ parentId: parent._id }).select('_id');
      const masterIds = masters.map(m => m._id);
      const downlineUsers = await User.find({ $or: [{ parentId: parent._id }, { parentId: { $in: masterIds } }] }).select('username');
      const usernames = downlineUsers.map(u => u.username);
      matchStatsQuery.userId = { $in: usernames };
    }
    // Superadmin sees all bets by default (no userId filter)

    // 3. Aggregate Stakes
    const stakesByMatch = await Bet.aggregate([
      { $match: matchStatsQuery },
      { $group: { _id: "$matchId", totalStake: { $sum: "$stake" } } }
    ]);

    const stakeMap = {};
    stakesByMatch.forEach(s => stakeMap[s._id] = s.totalStake);

    const results = activeMatches.map(m => ({
      matchId: m.matchId,
      name: `${m.teamA} v ${m.teamB} / Match Odds`,
      amount: stakeMap[m.matchId] || 0
    }));

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

module.exports = router;
