const mongoose = require('mongoose');
require('dotenv').config();
const Transaction = require('../models/Transaction');

async function dump() {
    await mongoose.connect(process.env.MONGO_URI);
    const txs = await Transaction.find({ bettor: 'bilal' });
    console.log(JSON.stringify(txs, null, 2));
    process.exit(0);
}

dump();
