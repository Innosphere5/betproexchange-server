require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { generateFinalSheet } = require('../services/finalSheetEngine');

async function testFinalSheet() {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const haji = await User.findOne({ username: 'haji' });
  const adnan = await User.findOne({ username: 'adnan' });

  const types = ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT'];
  const txs = await Transaction.find({ type: { $in: types } }).sort({ createdAt: -1 });

  console.log('=== TEST CURRENT FINAL SHEET FOR HAJI (ADMIN) ===');
  const hajiSheet = await generateFinalSheet(haji, txs);
  console.log('Haji Green Entries:', hajiSheet.greenEntries);
  console.log('Haji Red Entries:', hajiSheet.redEntries);
  console.log('Haji Total Green:', hajiSheet.totalGreen, 'Total Red:', hajiSheet.totalRed);

  console.log('\n=== TEST CURRENT FINAL SHEET FOR ADNAN (SUPERADMIN) ===');
  const adnanSheet = await generateFinalSheet(adnan, txs);
  console.log('Adnan Green Entries:', adnanSheet.greenEntries);
  console.log('Adnan Red Entries:', adnanSheet.redEntries);
  console.log('Adnan Total Green:', adnanSheet.totalGreen, 'Total Red:', adnanSheet.totalRed);

  process.exit(0);
}

testFinalSheet();
