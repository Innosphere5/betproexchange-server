require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('./models/Transaction');

async function cleanup() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to DB");

    // Remove SETTLEMENT transactions that were created for Credit loads/withdrawals
    const res = await Transaction.deleteMany({
      type: 'SETTLEMENT',
      description: { $regex: /^Credit /i }
    });

    console.log(`Deleted ${res.deletedCount} erroneous credit settlement transactions.`);
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

cleanup();
