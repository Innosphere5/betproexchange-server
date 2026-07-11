require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const User = require('./models/User');
  const Transaction = require('./models/Transaction');
  
  console.log("=== USERS ===");
  const users = await User.find({}).lean();
  for (const u of users) {
    console.log(`Username: ${u.username}, Role: ${u.role}, Share: ${u.share}, ParentId: ${u.parentId}`);
  }
  
  console.log("\n=== TRANSACTIONS FOR bet22 or matching bet22 ===");
  const txs = await Transaction.find({ $or: [{ userId: 'bet22' }, { bettor: 'bet22' }, { downline: 'bet22' }] }).lean();
  for (const tx of txs) {
    console.log(`ID: ${tx._id}, userId: ${tx.userId}, amount: ${tx.amount}, type: ${tx.type}, bettor: ${tx.bettor}, downline: ${tx.downline}, createdAt: ${tx.createdAt}`);
  }

  console.log("\n=== ALL TRANSACTIONS ===");
  const allTxs = await Transaction.find({}).sort({ createdAt: -1 }).limit(30).lean();
  for (const tx of allTxs) {
    console.log(`userId: ${tx.userId}, amount: ${tx.amount}, type: ${tx.type}, bettor: ${tx.bettor}, downline: ${tx.downline}, matchName: ${tx.matchName}, category: ${tx.category}, createdAt: ${tx.createdAt}`);
  }

  mongoose.disconnect();
}).catch(err => {
  console.error("Connection error:", err);
});
