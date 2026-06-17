require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const txs = await Transaction.find({ type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] } }).sort({ createdAt: -1 });
  txs.forEach(tx => console.log(`User: ${tx.userId}, Bettor: ${tx.bettor}, Downline: ${tx.downline}`));
  process.exit();
});
