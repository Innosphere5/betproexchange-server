const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

async function testLedger() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/betproexchange');
  console.log("Connected to DB");

  // Find a test user or superadmin
  const admin = await User.findOne({ role: 'superadmin' }) || await User.findOne({});
  if (!admin) {
    console.log("No user found");
    process.exit(0);
  }

  console.log("Testing ledger for user:", admin.username);

  const priorTransactions = await Transaction.find({
    userId: admin.username
  }).sort({ createdAt: 1 });

  console.log("Found total transactions for user:", priorTransactions.length);
  
  let openingBalance = 0;
  const entries = [];
  entries.push({
    id: 1,
    date: new Date().toLocaleString(),
    description: 'Opening Balance',
    amount: 0,
    balance: openingBalance
  });

  let runningBalance = openingBalance;
  priorTransactions.forEach((tx, idx) => {
    runningBalance += (tx.amount || 0);
    entries.push({
      id: idx + 2,
      date: new Date(tx.createdAt).toLocaleString(),
      description: tx.description,
      amount: tx.amount,
      balance: runningBalance
    });
  });

  console.log("Ledger entries sample:", entries.slice(0, 5));
  await mongoose.disconnect();
}

testLedger().catch(console.error);
