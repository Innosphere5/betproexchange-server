const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

async function testSave() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/betproexchange');
  console.log("Connected to MongoDB");

  const tx = new Transaction({
    userId: 'test_admin',
    amount: -100000,
    type: 'CREDIT_GIVEN',
    category: 'credit',
    description: 'Credit Issued to TestMaster (Credit)',
    performedBy: 'test_admin'
  });

  await tx.save();
  console.log("✅ Successfully saved transaction with category: credit! ID:", tx._id);

  // Clean up test transaction
  await Transaction.deleteOne({ _id: tx._id });
  console.log("Cleaned up test record");

  await mongoose.disconnect();
}

testSave().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
