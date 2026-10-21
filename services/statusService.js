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

                // When match goes live, toss has completed in real time → close toss market
                if (newStatus === 'live') {
                    match.tossMarketStatus = 'CLOSED';
                    match.tossBackA = null;
                    match.tossLayA = null;
                    match.tossBackB = null;
                    match.tossLayB = null;
                    match.tossDepthBackA = '0';
                    match.tossDepthLayA = '0';
                    match.tossDepthBackB = '0';
                    match.tossDepthLayB = '0';
                }

                await match.save();
                console.log(`[StatusService] Match ${match.matchId} status updated to ${newStatus}${newStatus === 'live' ? ' (Toss Market Closed)' : ''}`);

                // Immediately sync with UI so "LIVE" badge appears
                if (io) {
                    io.emit('live_score_update', {
                        matchId: match.matchId,
                        status: newStatus
                    });

                    if (newStatus === 'live') {
                        io.emit('toss_odds_update', {
                            matchId: String(match.matchId),
                            tossMarketStatus: 'CLOSED',
                            tossWinner: match.tossWinner || null,
                            tossBackA: null,
                            tossLayA: null,
                            tossBackB: null,
                            tossLayB: null,
                            isLive: true,
                            updatedAt: now
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error updating match statuses:', error.message);
    }
};

module.exports = { updateMatchStatuses };
