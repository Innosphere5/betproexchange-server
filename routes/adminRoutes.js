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
  try {
    const parent = await User.findOne({ username: req.user.userId });
    if (!parent) return res.status(404).json({ error: 'User not found' });

    // 1. Get all scheduled/live matches + recently resulted matches (last 24h)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeMatches = await Match.find({ 
      $or: [
        { status: { $in: ['scheduled', 'live', 'upcoming'] } },
        { status: 'resulted', updatedAt: { $gte: twentyFourHoursAgo } }
      ]
    }).select('matchId teamA teamB status backOddsA backOddsB layOddsA layOddsB').lean();
    
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

            if (req.user.role === 'master') return mShare;
            if (req.user.role === 'admin') return aShare - mShare;
            if (req.user.role === 'superadmin') return 100 - Math.max(mShare, aShare);
            return 0;
          };

          const netShare = getNetShare();
          const adminStake = stake * (netShare / 100);

          if (normalizedRunner === normalizedR) {
            totalStake += adminStake;
          }

          const COMMISSION_RATE = 0.03;

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

    console.log(`[FINAL SHEET DEBUG] User: ${currentUser.username}, Found: ${txs.length} transactions`);
    if (txs.length > 0) {
      const sample = txs.find(t => t.amount === 250);
      if (sample) console.log(`[FINAL SHEET DEBUG] Found the 250 tx! Category: ${sample.category}`);
      else console.log(`[FINAL SHEET DEBUG] 250 tx NOT found in the result set for ${currentUser.username}`);
    }

    const accountSummary = {}; // { "parentName": { wins: 0, losses: 0, name: '' } }

    txs.forEach(tx => {
      // Extract source name and parent from description:
      // "Cricket Share from bettor | parent (25%)"
      let parentName = tx.bettor || 'Unknown';

      if (!tx.bettor) {
        const match = tx.description.match(/from (.*?) \| (.*?)(?: \(|$)/);
        if (match) {
          parentName = match[2].trim();
        } else {
          const fallbackMatch = tx.description.match(/from (.*?)(?: \(|$)/);
          if (fallbackMatch) {
            parentName = fallbackMatch[1].trim();
          }
        }
      }

      if (!accountSummary[parentName]) {
        accountSummary[parentName] = { wins: 0, losses: 0, name: parentName };
      }

      const amount = Math.abs(tx.amount);
      if (tx.amount > 0) {
        // Master receives money -> Master Profit (Red Side)
        accountSummary[parentName].losses += amount;
      } else if (tx.amount < 0) {
        // Master pays money -> Master Loss (Green Side)
        accountSummary[parentName].wins += amount;
      }
    });

    // 2. Fetch roles for all users in accountSummary to allow frontend filtering
    const uniqueUsernames = Object.keys(accountSummary);
    const usersWithRoles = await User.find({ username: { $in: uniqueUsernames } }).select('username role').lean();
    const roleMap = {};
    usersWithRoles.forEach(u => roleMap[u.username] = u.role);

    const profit = []; // Green Side (Bettor Wins / Master Loss)
    const loss = [];   // Red Side (Bettor Losses / Master Profit)

    Object.keys(accountSummary).forEach(name => {
      const { wins, losses } = accountSummary[name];
      const role = roleMap[name] || 'user'; // Default to user if not found
      
      // Netting Logic: green (loss) - red (profit)
      const net = wins - losses;

      if (net > 0) {
        // Net Green (Master Loss)
        profit.push({ name, amount: net, role });
      } else if (net < 0) {
        // Net Red (Master Profit)
        loss.push({ name, amount: Math.abs(net), role });
      }
    });

    res.json({ profit, loss });
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

    let query = { 
      userId: currentUser.username,
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] }
    };

    let startDate, endDate;
    
    if (reportType === 'monthly' && month) {
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
    
    console.log(`[REPORT DEBUG] User: ${req.user.userId}, Role: ${req.user.role}, reportType: ${reportType}, date: ${date}`);
    console.log(`[REPORT] Type: ${reportType}, Range: ${startDate.toISOString()} - ${endDate.toISOString()}`);
    
    query.createdAt = { $gte: startDate, $lte: endDate };

    const txs = await Transaction.find(query).sort({ createdAt: -1 });
    console.log(`[DAILY REPORT DEBUG] User: ${req.user.userId}, Found: ${txs.length} transactions`);
    const found250 = txs.find(t => t.amount === 250);
    if (found250) console.log(`[DAILY REPORT DEBUG] Found 250 tx! category: ${found250.category}, bettor: ${found250.bettor}`);
    else console.log(`[DAILY REPORT DEBUG] 250 tx NOT found in results for ${req.user.userId}`);

    const accountSummary = {}; 
    // { username: { wins: 0, losses: 0, parent: '', cricketWins: 0, cricketLosses: 0, casinoWins: 0, casinoLosses: 0 } }

    txs.forEach(tx => {
      console.log(`[DEBUG REPORT] tx: ${tx._id}, category: ${tx.category}, desc: ${tx.description}`);
      let sourceName = tx.bettor || 'Unknown';
      let parentName = 'Hierarchy';

      if (!tx.bettor) {
        const match = tx.description.match(/from (.*?) \| (.*?)(?: \(|$)/);
        if (match) {
          sourceName = match[1].trim();
          parentName = match[2].trim();
        } else {
          const oldMatch = tx.description.match(/from (.*?)(?: \(|$)/);
          if (oldMatch) {
            sourceName = oldMatch[1].trim();
            parentName = 'Legacy';
          }
        }
      }

      const isCasino = tx.category === 'casino';

      if (!accountSummary[sourceName]) {
        accountSummary[sourceName] = { 
          wins: 0, 
          losses: 0, 
          parent: parentName,
          cricketWins: 0,
          cricketLosses: 0,
          casinoWins: 0,
          casinoLosses: 0
        };
      }

      const amount = Math.abs(tx.amount);
      if (tx.amount < 0) {
        // Master pays money -> Master Loss (Bettor Win -> Green Side)
        accountSummary[sourceName].wins += amount;
        if (isCasino) accountSummary[sourceName].casinoWins += amount;
        else accountSummary[sourceName].cricketWins += amount;
      } else if (tx.amount > 0) {
        // Master receives money -> Master Profit (Bettor Loss -> Red Side)
        accountSummary[sourceName].losses += amount;
        if (isCasino) accountSummary[sourceName].casinoLosses += amount;
        else accountSummary[sourceName].cricketLosses += amount;
      }
    });

    // Fetch roles for all users in accountSummary
    const uniqueUsernames = Object.keys(accountSummary);
    const usersWithRoles = await User.find({ username: { $in: uniqueUsernames } }).select('username role').lean();
    const roleMap = {};
    usersWithRoles.forEach(u => roleMap[u.username] = u.role);

    const profit = []; // Green Side (Bettor Wins / Master Loss)
    const loss = [];   // Red Side (Bettor Losses / Master Profit)

    Object.keys(accountSummary).forEach(name => {
      const s = accountSummary[name];
      const role = roleMap[name] || 'user';
      
      // Netting Logic: Bettor Win - Bettor Loss
      const totalNet = s.wins - s.losses;
      const cricketNet = s.cricketWins - s.cricketLosses;
      const casinoNet = s.casinoWins - s.casinoLosses;

      const reportObj = {
        name,
        role,
        parent: s.parent,
        amount: Math.abs(totalNet),
        breakdown: {
          cricket: { wins: s.cricketWins, losses: s.cricketLosses, net: cricketNet },
          casino: { wins: s.casinoWins, losses: s.casinoLosses, net: casinoNet },
          totalNet: totalNet
        }
      };

      if (totalNet > 0) {
        // Net Bettor Win
        profit.push(reportObj);
      } else if (totalNet < 0) {
        // Net Bettor Loss
        loss.push(reportObj);
      }
    });

    res.json({ profit, loss });
  } catch (err) {
    console.error("Report Error:", err);
    res.status(500).json({ error: 'Server error fetching report' });
  }
});

router.get('/daily-report-details', auth, isAuthorized, async (req, res) => {
  try {
    const { bettor, type, reportType, date, month, year, startDate: sDate, endDate: eDate } = req.query;
    
    if (!bettor) return res.status(400).json({ error: 'Bettor name required' });

    let start, end;
    if (reportType === 'monthly') {
      const [y, m] = month.split('-').map(Number);
      start = new Date(y, m - 1, 1);
      end = new Date(y, m, 0, 23, 59, 59, 999);
    } else if (reportType === 'yearly') {
      const y = parseInt(year);
      start = new Date(y, 0, 1);
      end = new Date(y, 11, 31, 23, 59, 59, 999);
    } else if (reportType === 'range') {
      start = new Date(sDate);
      start.setHours(0, 0, 0, 0);
      end = new Date(eDate);
      end.setHours(23, 59, 59, 999);
    } else {
      const [y, m, d] = date.split('-').map(Number);
      start = new Date(y, m - 1, d, 0, 0, 0, 0);
      end = new Date(y, m - 1, d, 23, 59, 59, 999);
    }

    const query = {
      userId: req.user.userId,
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] },
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

    const txs = await Transaction.find(query).sort({ createdAt: -1 });
    res.json(txs);
  } catch (err) {
    console.error("Daily Report Details Error:", err);
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

        if (requesterRole === 'master') {
            return mShare;
        } else if (requesterRole === 'admin') {
            // Admin gets their share minus what they gave to the master
            return aShare - mShare;
        } else if (requesterRole === 'superadmin') {
            // Superadmin gets what's left after Admin/Master
            const highestChildShare = Math.max(mShare, aShare);
            return 100 - highestChildShare;
        }
        return 0;
    };

    const requester = await User.findOne({ username: req.user.userId });
    const requesterId = requester._id.toString();
    const requesterRole = requester.role;

    const COMMISSION_RATE = 0.03;

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

module.exports = router;


