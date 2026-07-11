require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { generateFinalSheet } = require('../services/finalSheetEngine');

async function test() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Clean up
    await User.deleteMany({ username: { $in: ['test_sa', 'test_admin', 'test_master', 'test_bettor'] } });
    await Transaction.deleteMany({ userId: { $in: ['test_sa', 'test_admin', 'test_master', 'test_bettor'] } });

    // Create hierarchy
    const sa = await User.create({ username: 'test_sa', password: '123', role: 'superadmin', walletBalance: 0 });
    const admin = await User.create({ username: 'test_admin', password: '123', role: 'admin', share: 50, parentId: sa._id, walletBalance: 0 });
    const master = await User.create({ username: 'test_master', password: '123', role: 'master', share: 25, parentId: admin._id, walletBalance: 0 });
    const bettor = await User.create({ username: 'test_bettor', password: '123', role: 'user', parentId: master._id, walletBalance: 0 });

    console.log("Hierarchy created.");

    // Scenario A: Admin deposits 50,000 to Master
    // This creates a SETTLEMENT transaction for the admin (userId: test_admin, amount: -50000, downline: test_master)
    await Transaction.create({
      userId: 'test_admin',
      amount: -50000,
      type: 'SETTLEMENT',
      category: 'wallet',
      downline: 'test_master',
      description: 'Cash Deposit Settlement for test_master',
      performedBy: 'test_admin'
    });

    // Scenario B: SuperAdmin deposits 20,000 to Admin
    // This creates a SETTLEMENT transaction for the superadmin (userId: test_sa, amount: -20000, downline: test_admin)
    await Transaction.create({
      userId: 'test_sa',
      amount: -20000,
      type: 'SETTLEMENT',
      category: 'wallet',
      downline: 'test_admin',
      description: 'Cash Deposit Settlement for test_admin',
      performedBy: 'test_sa'
    });

    async function runFinalSheetForUser(username) {
      const currentUser = await User.findOne({ username });
      const txs = await Transaction.find({ 
        userId: currentUser.username,
        type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT'] }
      }).sort({ createdAt: -1 });

      return await generateFinalSheet(currentUser, txs, true);
    }

    console.log("\n=================== ADMIN FINAL SHEET (with Master settlement) ===================");
    const adminSheet = await runFinalSheetForUser('test_admin');
    console.log(`Green Total: ${adminSheet.totalGreen}, Red Total: ${adminSheet.totalRed}, Balanced: ${adminSheet.totalGreen === adminSheet.totalRed}`);
    console.log(JSON.stringify(adminSheet.greenEntries, null, 2));
    console.log(JSON.stringify(adminSheet.redEntries, null, 2));

    console.log("\n=================== SUPERADMIN FINAL SHEET (with Admin settlement) ===================");
    const saSheet = await runFinalSheetForUser('test_sa');
    console.log(`Green Total: ${saSheet.totalGreen}, Red Total: ${saSheet.totalRed}, Balanced: ${saSheet.totalGreen === saSheet.totalRed}`);
    console.log(JSON.stringify(saSheet.greenEntries, null, 2));
    console.log(JSON.stringify(saSheet.redEntries, null, 2));

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
