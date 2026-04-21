const Match = require('../models/Match');
const { getData } = require('./apiManager');
const { settleMatch } = require('./settlementService');

/**
 * processMatchResults
 * 
 * Logic to fetch results from Sportmonks v2 API, identify completed matches, 
 * determine the winner, and trigger settlement.
 */
const processMatchResults = async (io) => {
    try {
        console.log('[ResultSettlement] Checking for completed match results...');
        
        // Find all matches that aren't completed yet
        const pendingMatches = await Match.find({ status: { $ne: 'completed' } });

        if (pendingMatches.length === 0) {
            console.log('[ResultSettlement] No pending matches found in DB.');
            return;
        }

        console.log(`[ResultSettlement] Found ${pendingMatches.length} pending matches in DB to check.`);

        // Use absolute dates for the last 3 days to be safe
        const d = new Date();
        const today = d.toISOString().split('T')[0];
        d.setDate(d.getDate() - 2);
        const threeDaysAgo = d.toISOString().split('T')[0];

        const response = await getData('fixtures', {
            filter: {
                'filter[starts_between]': `${threeDaysAgo},${today}`,
            },
            include: 'runs,localteam,visitorteam'
        });

        if (!response || !Array.isArray(response.data)) {
            console.warn('[ResultSettlement] API returned no fixture data for settlement.');
            return;
        }

        console.log(`[ResultSettlement] Fetched ${response.data.length} fixtures for the check.`);

        for (const match of pendingMatches) {
            const apiMatch = response.data.find(f => f.id?.toString() === match.matchId);

            if (!apiMatch) {
                // If not in the 3-day window, try fetching it individually if it's very old?
                // For now, just skip if not found
                continue;
            }

            // Sportmonks statuses: 'Finished', 'Aborted', 'No Result', 'Abandoned'
            const isCompleted = ['Finished', 'Aborted', 'No Result', 'Abandoned'].includes(apiMatch.status);

            if (isCompleted) {
                console.log(`[ResultSettlement] 🏆 Match ${match.matchId} (${match.teamA} v ${match.teamB}) is ${apiMatch.status}.`);

                let winningTeam = 'VOID'; 

                if (apiMatch.status === 'Finished') {
                    // Use winner_team_id if available, otherwise fallback to score
                    if (apiMatch.winner_team_id === apiMatch.localteam_id) {
                        winningTeam = match.teamA;
                    } else if (apiMatch.winner_team_id === apiMatch.visitorteam_id) {
                        winningTeam = match.teamB;
                    } else {
                        // Manual score fallback
                        const runs = apiMatch.runs || [];
                        const rA = runs.find(r => r.team_id === apiMatch.localteam_id)?.score || 0;
                        const rB = runs.find(r => r.team_id === apiMatch.visitorteam_id)?.score || 0;

                        if (rA > rB) winningTeam = match.teamA;
                        else if (rB > rA) winningTeam = match.teamB;
                        else winningTeam = 'TIE';
                    }
                }

                console.log(`[ResultSettlement] Identified winner: ${winningTeam}`);

                // Update Match Status and Score in DB
                match.status = 'completed';
                const runs = apiMatch.runs || [];
                const tA = runs.find(r => r.team_id === apiMatch.localteam_id);
                const tB = runs.find(r => r.team_id === apiMatch.visitorteam_id);
                
                match.score = {
                    teamA_runs: tA ? `${tA.score}/${tA.wickets}` : match.score?.teamA_runs || '0/0',
                    teamB_runs: tB ? `${tB.score}/${tB.wickets}` : match.score?.teamB_runs || '0/0',
                    overs: "Final",
                    lastUpdated: new Date()
                };
                
                await match.save();
                console.log(`[ResultSettlement] DB Match ${match.matchId} updated to completed.`);

                // Trigger Bet Settlement
                await settleMatch(match.matchId, winningTeam, io);

                // Notify Frontend that match is completed
                if (io) {
                    const allMatches = await Match.find().sort({ startTime: 1 });
                    io.emit('matches_updated', allMatches);
                }
            }
        }

    } catch (error) {
        console.error('[ResultSettlement] CRITICAL ERROR:', error.message);
    }
};

module.exports = { processMatchResults };
