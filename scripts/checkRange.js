const mongoose = require('mongoose');
require('dotenv').config();
const Transaction = require('../models/Transaction');

async function check() {
    await mongoose.connect(process.env.MONGO_URI);
    
    const start = new Date("2026-05-13T18:30:00.000Z");
    const end = new Date("2026-05-14T18:29:59.999Z");
    
    const txs = await Transaction.find({
        bettor: 'bilal',
        createdAt: { $gte: start, $lte: end }
    });
    
    console.log(JSON.stringify(txs, null, 2));
    process.exit(0);
}

check();
