require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Bet = require('../models/Bet');
const CasinoBet = require('../models/CasinoBet');
const AviatorBet = require('../models/AviatorBet');
const TeenPattiBet = require('../models/TeenPattiBet');
const AviatorXBet = require('../models/AviatorXBet');

async function inspectBilal() {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  console.log('=== USERS ===');
  const users = await User.find({ username: { $in: ['bilal', 'haji', 'adnan'] } }).lean();
  users.forEach(u => console.log(`Username: ${u.username}, Role: ${u.role}, Balance: ${u.walletBalance}, Credit: ${u.credit}, Share: ${u.share}`));

  console.log('\n=== TRANSACTIONS ===');
  const txs = await Transaction.find({ $or: [{ userId: 'bilal' }, { bettor: 'bilal' }, { downline: 'bilal' }] }).lean();
  console.log(`Total transactions count: ${txs.length}`);
  txs.forEach(t => console.log(`ID: ${t._id} | userId: ${t.userId} | type: ${t.type} | amount: ${t.amount} | bettor: ${t.bettor} | downline: ${t.downline} | desc: ${t.description} | match: ${t.matchName}`));

  console.log('\n=== ALL TRANSACTIONS IN DB ===');
  const allTxs = await Transaction.find({}).lean();
  console.log(`Total all txs count: ${allTxs.length}`);
  allTxs.forEach(t => console.log(`userId: ${t.userId} | type: ${t.type} | amount: ${t.amount} | bettor: ${t.bettor} | downline: ${t.downline} | desc: ${t.description} | match: ${t.matchName}`));

  console.log('\n=== BETS ===');
  const cBets = await Bet.find({}).lean();
  const casBets = await CasinoBet.find({}).lean();
  const avBets = await AviatorBet.find({}).lean();
  const tpBets = await TeenPattiBet.find({}).lean();
  const avxBets = await AviatorXBet.find({}).lean();
  console.log(`Cricket: ${cBets.length}, Casino: ${casBets.length}, Aviator: ${avBets.length}, TeenPatti: ${tpBets.length}, AviatorX: ${avxBets.length}`);
  console.log('Casino Bets:', casBets);
  console.log('TeenPatti Bets:', tpBets);

  process.exit(0);
}

inspectBilal();
