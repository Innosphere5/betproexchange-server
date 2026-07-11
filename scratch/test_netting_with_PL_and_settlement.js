require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { distributeProfitLoss } = require('../services/hierarchyService');
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

    // 1. Bettor loses 10,000 (House profit +10000)
    console.log("Simulating bettor loss of 10,000 (house profit)...");
    await distributeProfitLoss('test_bettor', 10000, { matchName: 'Bettor Loss Match' });

    // 2. Master withdraws 1,000 from Bettor (SETTLEMENT transaction for parent test_master with amount +1000)
    console.log("Simulating withdrawal of 1,000 by Master from Bettor...");
    await Transaction.create({
      userId: 'test_master',
      amount: 1000,
      type: 'SETTLEMENT',
      category: 'wallet',
      downline: 'test_bettor',
      description: 'Cash Withdraw Settlement for test_bettor',
      performedBy: 'test_master'
    });

    async function runFinalSheetForUser(username) {
      const currentUser = await User.findOne({ username });
      const txs = await Transaction.find({ 
        userId: currentUser.username,
        type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT'] }
      }).sort({ createdAt: -1 });

      return await generateFinalSheet(currentUser, txs, true);
    }

    console.log("\n=================== FINAL SHEET FOR MASTER WITH NETTING ===================");
    const masterSheet = await runFinalSheetForUser('test_master');
    console.log(`Green Total: ${masterSheet.totalGreen}, Red Total: ${masterSheet.totalRed}, Balanced: ${masterSheet.totalGreen === masterSheet.totalRed}`);
    console.log("Green Entries:", JSON.stringify(masterSheet.greenEntries, null, 2));
    console.log("Red Entries:", JSON.stringify(masterSheet.redEntries, null, 2));

    // Assertions
    const bettorInGreen = masterSheet.greenEntries.find(e => e.accountId === 'test_bettor');
    const bettorInRed = masterSheet.redEntries.find(e => e.accountId === 'test_bettor');
    const masterInGreen = masterSheet.greenEntries.find(e => e.accountId === 'test_master');
    const masterInRed = masterSheet.redEntries.find(e => e.accountId === 'test_master');

    console.log("\n=================== VERIFICATIONS ===================");
    console.log(`Is test_bettor ONLY in green? ${!!bettorInGreen && !bettorInRed} (Amount: ${bettorInGreen?.amount})`);
    console.log(`Is test_master ONLY in red? ${!masterInGreen && !!masterInRed} (Amount: ${masterInRed?.amount})`);
    console.log(`Do totals match? ${masterSheet.totalGreen === masterSheet.totalRed} (Amount: ${masterSheet.totalGreen})`);

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
