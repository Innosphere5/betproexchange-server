const mongoose = require('mongoose');
require('dotenv').config();
const Transaction = require('../models/Transaction');

async function migrate() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const txs = await Transaction.find({});
    console.log(`Found ${txs.length} transactions to update`);

    for (const tx of txs) {
        const desc = (tx.description || '').toLowerCase();
        const match = (tx.matchName || '').toLowerCase();
        let category = 'cricket';
        if (desc.includes('casino') || desc.includes('rnd-') || match.includes('rnd-')) {
            category = 'casino';
        } else if (tx.type.includes('BALANCE') || tx.type.includes('CREDIT') || tx.type === 'WITHDRAW') {
            category = 'wallet';
        }
        tx.category = category;
        await tx.save();
    }

    console.log('Migration complete');
    process.exit(0);
}

migrate();
