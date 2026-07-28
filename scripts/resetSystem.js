const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const CasinoRound = require('../models/CasinoRound');
const AviatorBet = require('../models/AviatorBet');
const AviatorRound = require('../models/AviatorRound');
const AviatorXBet = require('../models/AviatorXBet');
const AviatorXRound = require('../models/AviatorXRound');
const TeenPattiBet = require('../models/TeenPattiBet');
const TeenPattiHand = require('../models/TeenPattiHand');

async function resetSystem() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/betproexchange';
    console.log('Connecting to MongoDB at:', mongoUri);
    await mongoose.connect(mongoUri);

    console.log('--- 1. Resetting Downline Accounts ---');
    // Delete all users except SuperAdmin
    const deletedUsers = await User.deleteMany({ role: { $ne: 'superadmin' } });
    console.log(`Deleted ${deletedUsers.deletedCount} non-superadmin accounts.`);

    // Reset SuperAdmin account balances to 100 Crore (₹1,000,000,000)
    const superadminRes = await User.updateMany(
      { role: 'superadmin' },
      { $set: { walletBalance: 1000000000, credit: 0 } }
    );
    console.log(`Reset ${superadminRes.modifiedCount} superadmin account(s) wallet balance to 100 Crore (₹1,000,000,000).`);

    console.log('--- 2. Clearing Transactions & Ledgers ---');
    const deletedTxs = await Transaction.deleteMany({});
    console.log(`Deleted ${deletedTxs.deletedCount} transactions.`);

    console.log('--- 3. Clearing All Game Bets & Rounds ---');
    const [
      cricketBets,
      casinoBets,
      casinoRounds,
      aviatorBets,
      aviatorRounds,
      aviatorXBets,
      aviatorXRounds,
      teenPattiBets,
      teenPattiHands
    ] = await Promise.all([
      Bet.deleteMany({}),
      CasinoBet.deleteMany({}),
      CasinoRound.deleteMany({}),
      AviatorBet.deleteMany({}),
      AviatorRound.deleteMany({}),
      AviatorXBet.deleteMany({}),
      AviatorXRound.deleteMany({}),
      TeenPattiBet.deleteMany({}),
      TeenPattiHand.deleteMany({})
    ]);

    console.log(`Deleted Cricket Bets: ${cricketBets.deletedCount}`);
    console.log(`Deleted Casino Bets: ${casinoBets.deletedCount}, Rounds: ${casinoRounds.deletedCount}`);
    console.log(`Deleted Aviator Bets: ${aviatorBets.deletedCount}, Rounds: ${aviatorRounds.deletedCount}`);
    console.log(`Deleted AviatorX Bets: ${aviatorXBets.deletedCount}, Rounds: ${aviatorXRounds.deletedCount}`);
    console.log(`Deleted TeenPatti Bets: ${teenPattiBets.deletedCount}, Hands: ${teenPattiHands.deletedCount}`);

    // Try deleting JetRun collections if they exist dynamically
    try {
      if (mongoose.connection.db) {
        if ((await mongoose.connection.db.listCollections({ name: 'jetrunbets' }).toArray()).length > 0) {
          await mongoose.connection.db.collection('jetrunbets').deleteMany({});
        }
        if ((await mongoose.connection.db.listCollections({ name: 'jetrunrounds' }).toArray()).length > 0) {
          await mongoose.connection.db.collection('jetrunrounds').deleteMany({});
        }
      }
    } catch (e) {
      console.log('Note: Optional jetrun collections check:', e.message);
    }

    console.log('==========================================');
    console.log('✅ SYSTEM SUCCESSFULLY RESET TO CLEAN START');
    console.log('==========================================');
  } catch (err) {
    console.error('❌ Error during system reset:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

resetSystem();
