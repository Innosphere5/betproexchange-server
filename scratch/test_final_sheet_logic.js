require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { distributeProfitLoss } = require('../services/hierarchyService');

async function test() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // 1. Clean up test users
    await User.deleteMany({ username: { $in: ['test_sa', 'test_admin', 'test_master', 'test_bettor'] } });
    await Transaction.deleteMany({ userId: { $in: ['test_sa', 'test_admin', 'test_master', 'test_bettor'] } });

    // 2. Create test hierarchy
    // SuperAdmin
    const sa = await User.create({ username: 'test_sa', password: '123', role: 'superadmin', walletBalance: 0 });
    // Admin (50% share)
    const admin = await User.create({ username: 'test_admin', password: '123', role: 'admin', share: 50, parentId: sa._id, walletBalance: 0 });
    // Master (25% share)
    const master = await User.create({ username: 'test_master', password: '123', role: 'master', share: 25, parentId: admin._id, walletBalance: 0 });
    // Bettor
    const bettor = await User.create({ username: 'test_bettor', password: '123', role: 'user', parentId: master._id, walletBalance: 0 });

    console.log("Hierarchy created successfully.");

    // 3. Bettor wins 950. In our system, bettor winning means house loses 950, so amount is -950.
    console.log("Simulating bettor win of 950 (house loss of -950)...");
    await distributeProfitLoss('test_bettor', -950, { matchName: 'Test Match Win' });

    const { generateFinalSheet } = require('../services/finalSheetEngine');

    // Helper to run final sheet logic locally
    async function runFinalSheetForUser(username) {
      const currentUser = await User.findOne({ username });
      const txs = await Transaction.find({ 
        userId: currentUser.username,
        type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT'] }
      }).sort({ createdAt: -1 });

      return await generateFinalSheet(currentUser, txs, true);
    }

    console.log("\n=================== FINAL SHEET FOR MASTER ===================");
    const masterSheet = await runFinalSheetForUser('test_master');
    console.log(JSON.stringify(masterSheet, null, 2));

    console.log("\n=================== FINAL SHEET FOR ADMIN ===================");
    const adminSheet = await runFinalSheetForUser('test_admin');
    console.log(JSON.stringify(adminSheet, null, 2));

    console.log("\n=================== FINAL SHEET FOR SUPERADMIN ===================");
    const superAdminSheet = await runFinalSheetForUser('test_sa');
    console.log(JSON.stringify(superAdminSheet, null, 2));

    // Clean up
    await User.deleteMany({ username: { $in: ['test_sa', 'test_admin', 'test_master', 'test_bettor'] } });
    await Transaction.deleteMany({ userId: { $in: ['test_sa', 'test_admin', 'test_master', 'test_bettor'] } });

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

test();
