require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Transaction = require('./models/Transaction');

async function restore() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to DB");

    // Restore user 50 walletBalance to 5000000 (credit value)
    const user50 = await User.findOne({ username: '50' });
    if (user50) {
      user50.walletBalance = user50.credit || 5000000;
      await user50.save();
      console.log(`Restored user 50 walletBalance to ${user50.walletBalance}`);
    }

    // Remove test settlement transactions for 50 created recently
    const res = await Transaction.deleteMany({
      userId: { $in: ['50', 'adnan'] },
      type: 'SETTLEMENT',
      description: 'P/L to Cash transfer'
    });
    console.log(`Deleted ${res.deletedCount} test settlement transactions.`);
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

restore();
