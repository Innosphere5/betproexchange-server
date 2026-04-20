const Match = require('../models/Match');
const { getEvents } = require('./apiManager');
const { settleMatch } = require('./settlementService');

/**
 * processMatchResults
 * 
 * Logic to fetch results from the API, identify completed matches, 
 * determine the winner, and trigger settlement.
 */
const processMatchResults = async (io) => {
    try {
        console.log('[ResultSettlement] Checking for completed match results...');
        
        // Find matches that are 'live' or 'upcoming' but might have finished
        const pendingMatches = await Match.find({ status: { $ne: 'completed' } });

        if (pendingMatches.length === 0) return;

        const sportsToFetch = [
            'cricket_ipl',
            'cricket_psl',
            'cricket_test_match',
            'cricket_odi',
            'cricket_international_t20'
        ];

        let allResultData = [];
        for (const sport of sportsToFetch) {
            const data = await getEvents(sport, 'scores');
            if (Array.isArray(data)) {
                allResultData = [...allResultData, ...data];
            }
        }

        for (const match of pendingMatches) {
            const resultEntry = allResultData.find(r => r.id?.toString() === match.matchId);

            if (resultEntry && resultEntry.completed) {
                console.log(`[ResultSettlement] Match ${match.matchId} (${match.teamA} v ${match.teamB}) marked as COMPLETED by API.`);

                let winningTeam = 'VOID'; // Default if no clear winner

                if (resultEntry.scores && resultEntry.scores.length >= 2) {
                    const scoreA = resultEntry.scores.find(s => s.name === match.teamA);
                    const scoreB = resultEntry.scores.find(s => s.name === match.teamB);

                    if (scoreA && scoreB) {
                        // Extract numeric portion of score (e.g. "201/5" -> 201)
                        const runsA = parseInt(scoreA.score.split('/')[0]);
                        const runsB = parseInt(scoreB.score.split('/')[0]);

                        if (runsA > runsB) {
                            winningTeam = match.teamA;
                        } else if (runsB > runsA) {
                            winningTeam = match.teamB;
                        } else {
                            winningTeam = 'TIE';
                        }
                    }
                }

                // Update Match Status in DB
                match.status = 'completed';
                match.score = {
                    teamA_runs: resultEntry.scores.find(s => s.name === match.teamA)?.score || match.score.teamA_runs,
                    teamB_runs: resultEntry.scores.find(s => s.name === match.teamB)?.score || match.score.teamB_runs,
                    overs: "Final",
                    lastUpdated: new Date()
                };
                await match.save();

                // Trigger Bet Settlement
                await settleMatch(match.matchId, winningTeam, io);

                // Notify Frontend
                if (io) {
                    const allMatches = await Match.find().sort({ startTime: 1 });
                    io.emit('matches_updated', allMatches);
                }
            }
        }

    } catch (error) {
        console.error('[ResultSettlement] Error processing results:', error.message);
    }
};

module.exports = { processMatchResults };
