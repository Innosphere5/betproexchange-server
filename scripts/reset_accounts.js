require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const AviatorBet = require('../models/AviatorBet');
const AviatorXBet = require('../models/AviatorXBet');
const TeenPattiBet = require('../models/TeenPattiBet');

async function resetAllAccounts() {
  try {
    console.log('=== STARTING ACCOUNT RESET PROCESS ===');
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    console.log('Connected successfully.');

    // 1. Reset SuperAdmin
    const superadminResult = await User.updateMany(
      { role: 'superadmin' },
      { $set: { walletBalance: 1000000000, credit: 0, share: 100 } }
    );
    console.log(`[SUPERADMIN RESET] Updated ${superadminResult.modifiedCount} superadmin account(s) to 1,000,000,000 balance.`);

    // 2. Reset All Non-Superadmin Accounts (Admin, Master, User)
    const downlineUsers = await User.find({ role: { $ne: 'superadmin' } });
    let resetCount = 0;

    for (const u of downlineUsers) {
      const targetBalance = u.credit || 0;
      u.walletBalance = targetBalance;
      await u.save();
      console.log(`[USER RESET] ${u.role.toUpperCase()} "${u.username}": Credit = ${u.credit || 0} => Wallet Balance set to ${u.walletBalance}`);
      resetCount++;
    }
    console.log(`[DOWNLINE RESET] Successfully reset ${resetCount} downline accounts to their credit limit / baseline.`);

    // 3. Clear all transaction logs and bets
    const delTx = await Transaction.deleteMany({});
    const delBet = await Bet.deleteMany({});
    const delCasino = CasinoBet ? await CasinoBet.deleteMany({}) : { deletedCount: 0 };
    const delAviator = AviatorBet ? await AviatorBet.deleteMany({}) : { deletedCount: 0 };
    const delAviatorX = AviatorXBet ? await AviatorXBet.deleteMany({}) : { deletedCount: 0 };
    const delTeenPatti = TeenPattiBet ? await TeenPattiBet.deleteMany({}) : { deletedCount: 0 };

    console.log('=== CLEANUP SUMMARY ===');
    console.log(`- Transactions deleted: ${delTx.deletedCount}`);
    console.log(`- Cricket bets deleted: ${delBet.deletedCount}`);
    console.log(`- Casino bets deleted: ${delCasino.deletedCount || 0}`);
    console.log(`- Aviator bets deleted: ${delAviator.deletedCount || 0}`);
    console.log(`- AviatorX bets deleted: ${delAviatorX.deletedCount || 0}`);
    console.log(`- TeenPatti bets deleted: ${delTeenPatti.deletedCount || 0}`);

    console.log('=== ACCOUNT RESET COMPLETED SUCCESSFULLY ===');
    process.exit(0);
  } catch (err) {
    console.error('[RESET ERROR] Failed to reset accounts:', err);
    process.exit(1);
  }
}

resetAllAccounts();
