const mongoose = require('mongoose');
require('dotenv').config();
const Transaction = require('../models/Transaction');

async function findIt() {
    await mongoose.connect(process.env.MONGO_URI);
    const tx = await Transaction.findOne({ amount: 250, userId: 'rizwan sheikh' });
    console.log(JSON.stringify(tx, null, 2));
    process.exit(0);
}

findIt();
