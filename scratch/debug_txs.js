const mongoose = require('mongoose');
require('dotenv').config();
const Transaction = require('../models/Transaction');

async function checkTxs() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');
    
    const txs = await Transaction.find({ 
      type: { $in: ['COMMISSION_SHARE', 'PLATFORM_COMMISSION'] } 
    }).sort({ createdAt: -1 });
    
    console.log(`Found ${txs.length} transactions`);
    txs.forEach(tx => {
      console.log(`User: ${tx.userId}, Amount: ${tx.amount}, Type: ${tx.type}, CreatedAt: ${tx.createdAt}, Desc: ${tx.description}`);
    });
    
    const today = new Date();
    const startOfDay = new Date(today);
    startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23,59,59,999);
    
    console.log(`\nRange check (Today):`);
    console.log(`Start: ${startOfDay}`);
    console.log(`End:   ${endOfDay}`);
    
    const todayTxs = txs.filter(tx => tx.createdAt >= startOfDay && tx.createdAt <= endOfDay);
    console.log(`Found ${todayTxs.length} transactions for today`);

    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkTxs();
