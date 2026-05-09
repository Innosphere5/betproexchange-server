const mongoose = require('mongoose');
const Bet = require('../models/Bet');

async function inspect() {
    await mongoose.connect('mongodb+srv://gagndeep0101_db_user:gagan_user@betpro.v2ovyxx.mongodb.net/?retryWrites=true&w=majority&appName=betpro');
    
    const b = await Bet.findOne({ userId: 'hamza' });
    console.log(`Bet matchId: ${b.matchId} | Type: ${typeof b.matchId}`);
    
    process.exit(0);
}

inspect();
