require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const currentUser = await User.findOne({ username: 'adnan' }); // admin
  
  const txs = await Transaction.find({ 
    userId: currentUser.username,
    type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] }
  }).sort({ createdAt: -1 });

  const accountSummary = {}; 

  txs.forEach(tx => {
    let sourceName = tx.downline || tx.bettor || 'Unknown';

    if (!tx.bettor) {
      const match = tx.description.match(/from (.*?) \| (.*?)(?: \(|$)/);
      if (match) {
        sourceName = match[1].trim();
      } else {
        const fallbackMatch = tx.description.match(/from (.*?)(?: \(|$)/);
        if (fallbackMatch) {
          sourceName = fallbackMatch[1].trim();
        }
      }
    }

    if (!accountSummary[sourceName]) {
      accountSummary[sourceName] = { green: 0, red: 0, name: sourceName };
    }

    if (tx.amount > 0) {
      accountSummary[sourceName].green += tx.amount;
    } else if (tx.amount < 0) {
      accountSummary[sourceName].red += Math.abs(tx.amount);
    }
  });

  const uniqueUsernames = Object.keys(accountSummary);
  const usersWithRoles = await User.find({ username: { $in: uniqueUsernames } }).select('username role').lean();
  const roleMap = {};
  usersWithRoles.forEach(u => roleMap[u.username] = u.role);

  const accounts = Object.keys(accountSummary).map(name => {
    const { green, red } = accountSummary[name];
    const role = roleMap[name] || 'user';
    return {
      name,
      role,
      green: Math.round(green * 100) / 100,
      red: Math.round(red * 100) / 100,
      net: Math.round((green - red) * 100) / 100
    };
  }).filter(a => {
    if (currentUser.role === 'superadmin') return a.role === 'admin';
    if (currentUser.role === 'admin') return a.role === 'master';
    if (currentUser.role === 'master') return a.role === 'user';
    return false;
  });

  console.log("FINAL ACCOUNTS for adnan (admin):", accounts);

  process.exit();
});
