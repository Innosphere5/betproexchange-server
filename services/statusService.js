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
            
            // Assume matches last max 8 hours for completion
            const eightHoursLater = new Date(match.startTime.getTime() + 8 * 60 * 60 * 1000);
            if (now > eightHoursLater) {
                newStatus = 'completed';
            }

            if (newStatus !== match.status) {
                match.status = newStatus;
                match.lastUpdated = now;
                await match.save();
                console.log(`Match ${match.matchId} status updated to ${newStatus}`);

                if (newStatus === 'completed') {
                    // MVP: Randomly declare winner between teamA and teamB
                    const winningTeam = Math.random() > 0.5 ? match.teamA : match.teamB;
                    await settleMatch(`${match.teamA} v ${match.teamB}`, winningTeam, io);
                }
            }
        }
    } catch (error) {
        console.error('Error updating match statuses:', error.message);
    }
};

module.exports = { updateMatchStatuses };
