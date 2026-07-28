require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

async function testCalculation() {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const users = await User.find({}).lean();
  const userMap = {};
  users.forEach(u => { userMap[u.username] = u; });

  const txs = await Transaction.find({ type: 'COMMISSION_SHARE' }).lean();
  
  const bettorSummary = {};

  txs.forEach(tx => {
    // Only direct parent share transaction (where downline === bettor)
    if (tx.downline === tx.bettor) {
      const bettorName = tx.bettor;
      const bettorUser = userMap[bettorName];
      if (!bettorUser) return;

      const parentUser = userMap[tx.userId];
      const parentShare = parentUser ? (parentUser.share || 85) : 85;

      const bettorNetForTx = - (tx.amount / (parentShare / 100));

      if (!bettorSummary[bettorName]) {
        bettorSummary[bettorName] = { total: 0, transactions: [] };
      }
      bettorSummary[bettorName].total += bettorNetForTx;
      bettorSummary[bettorName].transactions.push({ match: tx.matchName, txAmount: tx.amount, parentShare, bettorNetForTx });
    }
  });

  console.log('=== ACCURATE BETTOR NET SUMMARY ===');
  console.log(JSON.stringify(bettorSummary, null, 2));

  process.exit(0);
}

testCalculation();
