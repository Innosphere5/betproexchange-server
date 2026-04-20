const Match = require('../models/Match');
const { settleMatch } = require('./settlementService');

const updateMatchStatuses = async (io) => {
    try {
        const now = new Date();
        const matches = await Match.find({ status: { $ne: 'completed' } });

        for (const match of matches) {
            let newStatus = match.status;

            // Simple logic: if startTime is reached, it's live
            if (now >= match.startTime && match.status === 'upcoming') {
                newStatus = 'live';
            }
            
            // Note: 'completed' status is now handled by resultSettlementService 
            // based on real API data to ensure accurate settlements.

            if (newStatus !== match.status) {
                match.status = newStatus;
                match.lastUpdated = now;
                await match.save();
                console.log(`[StatusService] Match ${match.matchId} status updated to ${newStatus}`);

                // Immediately sync with UI so "LIVE" badge appears
                if (io) {
                    const allMatches = await Match.find().sort({ startTime: 1 });
                    io.emit('matches_updated', allMatches);
                }
            }
        }
    } catch (error) {
        console.error('Error updating match statuses:', error.message);
    }
};

module.exports = { updateMatchStatuses };
