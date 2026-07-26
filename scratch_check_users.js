require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Transaction = require('./models/Transaction');

async function check() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to DB");
    const users = await User.find({}).lean();
    for (const u of users) {
      console.log(`User: ${u.username}, Role: ${u.role}, Credit: ${u.credit}, WalletBalance: ${u.walletBalance}`);
    }
    const txs = await Transaction.find({ type: 'SETTLEMENT' }).lean();
    console.log("Settlement Transactions:", txs);
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}
check();
