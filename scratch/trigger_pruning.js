const mongoose = require('mongoose');
require('dotenv').config();
const Match = require('../models/Match');

async function triggerPruning() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB. Running pruning logic...');

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const staleLiveTime = new Date(Date.now() - 12 * 60 * 60 * 1000);

        // Prune matches that are not in the top list and are old or live-stale
        // For this manual trigger, we assume activeIds are the ones we want to keep.
        // We'll just target Romania v Bulgaria specifically for verification if needed,
        // or just run the generic logic.
        
        const deleteResult = await Match.deleteMany({
            $or: [
                { startTime: { $lt: todayStart }, status: { $ne: 'live' } },
                { status: 'live', startTime: { $lt: staleLiveTime } }
            ]
        });

        console.log(`Pruned ${deleteResult.deletedCount} matches.`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

triggerPruning();
