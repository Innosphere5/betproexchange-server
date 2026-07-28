require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { generateFinalSheet } = require('../services/finalSheetEngine');

async function testFinalSheet() {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const haji = await User.findOne({ username: 'haji' });
  const adnan = await User.findOne({ username: 'adnan' });
  const master25 = await User.findOne({ username: '25' });

  const types = ['COMMISSION_SHARE', 'PLATFORM_COMMISSION', 'BOOK_SHARE', 'SETTLEMENT'];
  const txs = await Transaction.find({ type: { $in: types } }).sort({ createdAt: -1 });

  console.log('=== TEST FINAL SHEET FOR ADNAN (SUPERADMIN) ===');
  const adnanSheet = await generateFinalSheet(adnan, txs, false);
  console.log('Adnan Green Entries:', adnanSheet.greenEntries);
  console.log('Adnan Red Entries:', adnanSheet.redEntries);
  console.log('Adnan Total Green:', adnanSheet.totalGreen, 'Total Red:', adnanSheet.totalRed);

  console.log('\n=== TEST FINAL SHEET FOR HAJI (ADMIN) ===');
  const hajiSheet = await generateFinalSheet(haji, txs, false);
  console.log('Haji Green Entries:', hajiSheet.greenEntries);
  console.log('Haji Red Entries:', hajiSheet.redEntries);

  if (master25) {
    console.log('\n=== TEST FINAL SHEET FOR MASTER 25 ===');
    const m25Sheet = await generateFinalSheet(master25, txs, false);
    console.log('Master 25 Green Entries:', m25Sheet.greenEntries);
    console.log('Master 25 Red Entries:', m25Sheet.redEntries);
  }

  console.log('\n=== TEST DAILY REPORT FOR ADNAN (SUPERADMIN) ===');
  const adnanDaily = await generateFinalSheet(adnan, txs, true);
  console.log('Adnan Daily Green Entries:', adnanDaily.greenEntries);
  console.log('Adnan Daily Red Entries:', adnanDaily.redEntries);
  console.log('Adnan Daily Total Green:', adnanDaily.totalGreen, 'Total Red:', adnanDaily.totalRed);

  process.exit(0);
}

testFinalSheet();
