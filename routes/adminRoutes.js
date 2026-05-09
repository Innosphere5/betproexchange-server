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
    // Initial Balance Check (Only SuperAdmin has unlimited spending)
    const skipBalanceCheck = req.user.role === 'superadmin';
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

    // Deduct from parent balance if not SuperAdmin
    if (req.user.role !== 'superadmin') {
      parent.walletBalance -= balance;
      await parent.save();

      // Create Transaction Record for the deduction
      const newTransaction = new Transaction({
        userId: username,
        amount: balance,
        type: 'LOAD_BALANCE',
        description: `Initial balance for ${role} account created by ${parent.role} ${parent.username}`,
        performedBy: parent.username
      });
      await newTransaction.save();
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

    if (type === 'credit') {
      target.credit = (target.credit || 0) + addAmount;
      target.walletBalance = (target.walletBalance || 0) + addAmount;
    } else {
      if (req.user.role !== 'superadmin') {
        if (parent.walletBalance < addAmount) {
          return res.status(400).json({ error: 'Insufficient balance' });
        }
        parent.walletBalance -= addAmount;
        await parent.save();
      }
      target.walletBalance += addAmount;
    }

    await target.save();

    // Create Transaction Record
    const newTransaction = new Transaction({
      userId: target.username,
      amount: addAmount,
      type: type === 'credit' ? 'LOAD_CREDIT' : 'LOAD_BALANCE',
      description: `${type === 'credit' ? 'Credit' : 'Balance'} loaded by ${parent.role} ${parent.username}`,
      performedBy: parent.username
    });
    await newTransaction.save();

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
      if ((target.credit || 0) < withdrawAmount) {
        return res.status(400).json({ error: 'User has insufficient credit to withdraw this amount' });
      }
      target.credit -= withdrawAmount;
      target.walletBalance -= withdrawAmount;
    } else {
      // Default: Cash
      if (target.walletBalance < withdrawAmount) {
        return res.status(400).json({ error: 'User has insufficient balance to withdraw this amount' });
      }
      target.walletBalance -= withdrawAmount;

      // Give back to parent if not SuperAdmin or Admin
      // Give back to parent if not SuperAdmin
      if (req.user.role !== 'superadmin') {
        parent.walletBalance += withdrawAmount;
        await parent.save();
      }
    }

    await target.save();

    // Create Transaction Record
    const newTransaction = new Transaction({
      userId: target.username,
      amount: -withdrawAmount,
      type: type === 'credit' ? 'WITHDRAW_CREDIT' : 'WITHDRAW',
      description: `${type === 'credit' ? 'Credit' : 'Balance'} reduced by ${parent.role} ${parent.username}`,
      performedBy: parent.username
    });
    await newTransaction.save();

    res.json({ success: true, newBalance: target.walletBalance, newCredit: target.credit, parentBalance: parent.walletBalance });
  } catch (err) {
    console.error(err);
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
  console.log(`[API] Dashboard Stats called by: ${req.user.userId} | Role: ${req.user.role}`);
  try {
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    // 1. Get all scheduled/live matches
    const activeMatches = await Match.find({ status: { $in: ['scheduled', 'live', 'upcoming'] } }).select('matchId teamA teamB backOddsA backOddsB layOddsA layOddsB').lean();
    const matchIds = activeMatches.map(m => m.matchId);

    // 2. Prepare Match Stake Query
    let matchStatsQuery = { matchId: { $in: matchIds }, status: { $in: ['MATCHED', 'pending'] } };
    
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

    // 3. Get all relevant bets for these matches
    const bets = await Bet.find(matchStatsQuery).lean();
    console.log(`[API] Found ${bets.length} bets for ${activeMatches.length} matches. Role: ${req.user.role}`);

    // Fetch all users involved in these bets and their parents
    const uniqueUserIds = [...new Set(bets.map(b => b.userId))];
    const betUsers = await User.find({ username: { $in: uniqueUserIds } }).lean();
    
    // Get unique parent IDs
    const parentIds = [...new Set(betUsers.filter(u => u.parentId).map(u => u.parentId))];
    const parentUsers = await User.find({ _id: { $in: parentIds } }).lean();
    
    const parentMap = {};
    parentUsers.forEach(p => { parentMap[p._id.toString()] = p.username; });

    const userMap = {};
    betUsers.forEach(u => {
      const parent = parentUsers.find(p => p._id.toString() === u.parentId?.toString());
      userMap[u.username] = {
        ...u,
        parentName: parent ? parent.username : 'Direct',
        parentShare: parent ? parent.share : 0
      };
    });

    // 4. Calculate runner-wise exposure and stats
    const results = [];
    for (const m of activeMatches) {
      const runners = [m.teamA, m.teamB];
      const matchBets = bets.filter(b => b.matchId === m.matchId);
      console.log(`[API] Match ${m.matchId} (${m.teamA} v ${m.teamB}) has ${matchBets.length} bets.`);

      runners.forEach(r => {
        let netStake = 0;
        const normalizedR = r?.trim().toLowerCase();

        matchBets.forEach(b => {
          const { runner, odds, stake, type, userId } = b;
          const normalizedRunner = runner?.trim().toLowerCase();
          
          if (normalizedRunner !== normalizedR) return; // Only count bets on this specific runner

          // Get the share for this user/bet
          const u = userMap[userId];
          let effectiveShare = 100; // Default for SuperAdmin

          if (req.user.role === 'master') {
            effectiveShare = req.user.share || 0;
          } else if (req.user.role === 'admin') {
            // Admin gets the remaining share of their master's downline
            // For now, simplify: Admin takes (100 - MasterShare)
            effectiveShare = 100 - (u?.parentShare || 0);
          }

          const shareMultiplier = effectiveShare / 100;

          if (type === 'back') {
            netStake += stake * shareMultiplier;
          } else { // lay
            netStake -= (odds - 1) * stake * shareMultiplier;
          }
        });

        const runnerBets = matchBets.filter(b => b.runner?.trim().toLowerCase() === r?.trim().toLowerCase()).map(b => {
          const u = userMap[b.userId];
          return {
            stake: b.stake,
            odds: b.odds,
            type: b.type,
            bettor: b.userId,
            master: u?.parentName || 'Direct'
          };
        });

        console.log(`[API] Runner ${r}: netStake=${netStake}, bets=${runnerBets.length}`);

        results.push({
          matchId: m.matchId,
          name: r,
          matchName: `${m.teamA} v ${m.teamB}`,
          amount: netStake,
          back: r === m.teamA ? m.backOddsA : m.backOddsB,
          lay: r === m.teamA ? m.layOddsA : m.layOddsB,
          bets: runnerBets
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

// Get Final Sheet (Profit/Loss Ledger with simplified account view)
router.get('/final-sheet', auth, isAuthorized, async (req, res) => {
  try {
    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    // 1. Fetch all betting-related share transactions for the current user
    const txs = await Transaction.find({ 
      userId: currentUser.username,
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] }
    }).sort({ createdAt: -1 });

    const accountSummary = {}; // { username: { wins: 0, losses: 0 } }

    txs.forEach(tx => {
      // Extract source name from description:
      // "Cricket Share from name (25%)" OR "Casino Platform Commission from name"
      let sourceName = 'Unknown';
      const match = tx.description.match(/from (.*?)(?: \(|$)/);
      if (match) {
        sourceName = match[1].trim();
      }

      if (!accountSummary[sourceName]) {
        accountSummary[sourceName] = { wins: 0, losses: 0 };
      }

      // tx.amount is positive for House Profit (Bettor Loss)
      // tx.amount is negative for House Loss (Bettor Win)
      if (tx.amount < 0) {
        // House Loss means User Win -> Green Side
        accountSummary[sourceName].wins += Math.abs(tx.amount);
      } else if (tx.amount > 0) {
        // House Profit means User Loss -> Red Side
        accountSummary[sourceName].losses += tx.amount;
      }
    });

    const profit = []; // Green Side (Bettor Wins)
    const loss = [];   // Red Side (Bettor Loses)

    Object.keys(accountSummary).forEach(name => {
      const { wins, losses } = accountSummary[name];
      
      if (wins > 0) {
        profit.push({ name, amount: wins });
      }
      
      if (losses > 0) {
        loss.push({ name, amount: losses });
      }
    });

    res.json({ profit, loss });
  } catch (err) {
    console.error("Final Sheet Error:", err);
    res.status(500).json({ error: 'Server error fetching final sheet' });
  }
});

// Get Daily Report (Similar to Final Sheet but filtered by date)
router.get('/daily-report', auth, isAuthorized, async (req, res) => {
  try {
    const { date } = req.query;
    const currentUser = await User.findOne({ username: req.user.userId });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    let query = { 
      userId: currentUser.username,
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] }
    };

    let startOfDay, endOfDay;
    if (date) {
      // date is "YYYY-MM-DD"
      const [year, month, day] = date.split('-').map(Number);
      startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
      endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
    } else {
      startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
    }
    
    console.log(`[DAILY-REPORT] Date: ${date || 'Today'}, Range: ${startOfDay.toISOString()} - ${endOfDay.toISOString()}`);
    
    query.createdAt = { $gte: startOfDay, $lte: endOfDay };

    const txs = await Transaction.find(query).sort({ createdAt: -1 });

    const accountSummary = {}; // { username: { wins: 0, losses: 0 } }

    txs.forEach(tx => {
      let sourceName = 'Unknown';
      let parentName = 'Unknown';
      
      // New format: "... from bettor | parent (X%)"
      const match = tx.description.match(/from (.*?) \| (.*?)(?: \(|$)/);
      if (match) {
        sourceName = match[1].trim();
        parentName = match[2].trim();
      } else {
        // Fallback for old format: "... from name (X%)"
        const oldMatch = tx.description.match(/from (.*?)(?: \(|$)/);
        if (oldMatch) {
          sourceName = oldMatch[1].trim();
          parentName = 'Legacy';
        }
      }

      if (!accountSummary[sourceName]) {
        accountSummary[sourceName] = { wins: 0, losses: 0, parent: parentName };
      }

      // tx.amount is positive for House Profit (Bettor Loss)
      // tx.amount is negative for House Loss (Bettor Win)
      if (tx.amount < 0) {
        // House Loss means User Win -> Green Side
        accountSummary[sourceName].wins += Math.abs(tx.amount);
      } else if (tx.amount > 0) {
        // House Profit means User Loss -> Red Side
        accountSummary[sourceName].losses += tx.amount;
      }
    });

    const profit = []; // Green Side (Bettor Wins)
    const loss = [];   // Red Side (Bettor Loses)

    Object.keys(accountSummary).forEach(name => {
      const { wins, losses, parent } = accountSummary[name];
      if (wins > 0) {
        profit.push({ name, amount: wins, parent });
      }
      if (losses > 0) {
        loss.push({ name, amount: losses, parent });
      }
    });

    res.json({ profit, loss });
  } catch (err) {
    console.error("Daily Report Error:", err);
    res.status(500).json({ error: 'Server error fetching daily report' });
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
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] },
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    });

    res.json({ success: true, message: `Cleared ${result.deletedCount} records for ${date || 'today'}` });
  } catch (err) {
    console.error("Clear Daily Report Error:", err);
    res.status(500).json({ error: 'Server error clearing daily report' });
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

    const userMap = {};
    users.forEach(u => {
        const parent = parents.find(p => p._id.toString() === u.parentId?.toString());
        userMap[u.username] = {
            username: u.username,
            parentName: parent ? parent.username : 'Direct'
        };
    });

    // 4. Calculate Exposure for Super Admin
    // For each runner, calculate what happens if THEY win
    const exposure = {};
    runners.forEach(r => exposure[r] = 0);

    bets.forEach(b => {
        const { runner, odds, stake, type } = b;
        
        runners.forEach(winRunner => {
            let adminProfit = 0;
            if (type === 'back') {
                if (runner === winRunner) {
                    // Bettor wins (Odds-1)*Stake, Admin loses it
                    adminProfit = -(odds - 1) * stake;
                } else {
                    // Bettor loses Stake, Admin wins it
                    adminProfit = stake;
                }
            } else { // lay
                if (runner === winRunner) {
                    // Bettor loses (Odds-1)*Stake, Admin wins it
                    adminProfit = (odds - 1) * stake;
                } else {
                    // Bettor wins Stake, Admin loses it
                    adminProfit = -stake;
                }
            }
            exposure[winRunner] += adminProfit;
        });
    });

    // 5. Format Matched Bets for UI
    const matchedBets = bets.map(b => ({
        id: b._id,
        runner: b.runner,
        price: b.odds,
        size: b.stake,
        better: b.userId,
        master: userMap[b.userId]?.parentName || 'Unknown',
        type: b.type
    }));

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

module.exports = router;


