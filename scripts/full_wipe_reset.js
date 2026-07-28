require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const AviatorBet = require('../models/AviatorBet');
const AviatorXBet = require('../models/AviatorXBet');
const TeenPattiBet = require('../models/TeenPattiBet');

async function fullWipeReset() {
  try {
    console.log('=== STARTING FULL WIPE RESET (SUPERADMIN ONLY) ===');
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    console.log('Connected successfully.');

    // 1. Delete all downline users (Admin, Master, User)
    const deleteUsers = await User.deleteMany({ role: { $ne: 'superadmin' } });
    console.log(`[USER DELETION] Deleted ${deleteUsers.deletedCount} downline accounts.`);

    // 2. Reset SuperAdmin balance, credit, and share
    const superadminResult = await User.updateMany(
      { role: 'superadmin' },
      { $set: { credit: 0, walletBalance: 1000000000, share: 85 } }
    );
    console.log(`[SUPERADMIN RESET] Updated ${superadminResult.modifiedCount} superadmin account(s) to 1,000,000,000 balance.`);

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

    console.log('=== FULL WIPE RESET COMPLETED SUCCESSFULLY ===');
    process.exit(0);
  } catch (err) {
    console.error('[RESET ERROR] Failed to perform full wipe reset:', err);
    process.exit(1);
  }
}

fullWipeReset();
