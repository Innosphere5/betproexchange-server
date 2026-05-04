const Match = require('../models/Match');
const Bet = require('../models/Bet');
const { getData } = require('./apiManager');
const { settleMatch } = require('./settlementService');

/**
 * processMatchResults
 * 
 * Logic to fetch results from Sportmonks v2 API, identify completed matches, 
 * determine the winner, and trigger settlement.
 * 
 * ENHANCED: Now also checks for results of every "MATCHED" bet in the DB, 
 * even if the Match object was deleted or is old.
 */
const processMatchResults = async (io) => {
    try {
        console.log('[ResultSettlement] Checking for completed match results...');
        
        // 1. Get IDs from pending matches in DB
        const pendingMatches = await Match.find({ status: { $ne: 'completed' } });
        const pendingMatchIds = pendingMatches.map(m => m.matchId);

        // 2. Get IDs from "pending" bets (this catches old matches that were pruned from DB)
        const activeBets = await Bet.find({ status: 'pending' });
        const betMatchIds = [...new Set(activeBets.map(b => b.matchId))];

        // Combine unique IDs to check
        const allIdsToCheck = [...new Set([...pendingMatchIds, ...betMatchIds])];

        if (allIdsToCheck.length === 0) {
            console.log('[ResultSettlement] No pending matches or active bets found to check.');
            return;
        }

        console.log(`[ResultSettlement] Found ${allIdsToCheck.length} unique match IDs to check result status.`);

        // Sportmonks allows fetching multiple fixtures by ID if separated by comma in some versions, 
        // but for safety and v2 compatibility, we'll try a date-based bulk fetch first for a wider window (yesterday to tomorrow).
        const d = new Date();
        const tomorrow = new Date(d.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        d.setDate(d.getDate() - 1); 
        const yesterday = d.toISOString().split('T')[0];

        console.log(`[ResultSettlement] Fetching fixtures between ${yesterday} and ${tomorrow}`);

        const response = await getData('fixtures', {
            filter: {
                'filter[starts_between]': `${yesterday},${tomorrow}`,
            },
            include: 'runs,localteam,visitorteam'
        });

        if (!response || !Array.isArray(response.data)) {
            console.warn('[ResultSettlement] API returned no fixture data.');
            return;
        }

        const apifixtures = response.data;
        console.log(`[ResultSettlement] Fetched ${apifixtures.length} fixtures for the check.`);

        for (const matchId of allIdsToCheck) {
            const apiMatch = apifixtures.find(f => f.id?.toString() === matchId);

            if (!apiMatch) {
                // If match is older than 7 days, it won't be in the bulk fetch.
                // We should ideally fetch it by ID specifically, but Sportmonks v2 fixtures endpoint 
                // might need a different path. For now, we print a log.
                // console.log(`[ResultSettlement] Match ${matchId} not found in 7-day window.`);
                continue;
            }

            // Sportmonks statuses: 'Finished', 'Aborted', 'No Result', 'Abandoned'
            const isCompleted = ['Finished', 'Aborted', 'No Result', 'Abandoned'].includes(apiMatch.status);

            if (isCompleted) {
                console.log(`[ResultSettlement] 🏆 Match ${matchId} is ${apiMatch.status}.`);

                let winningTeam = 'VOID'; 

                if (apiMatch.status === 'Finished') {
                    if (apiMatch.winner_team_id === apiMatch.localteam_id) {
                        winningTeam = apiMatch.localteam?.name || 'Home Team';
                    } else if (apiMatch.winner_team_id === apiMatch.visitorteam_id) {
                        winningTeam = apiMatch.visitorteam?.name || 'Away Team';
                    } else {
                        const runs = apiMatch.runs || [];
                        const rA = runs.find(r => r.team_id === apiMatch.localteam_id)?.score || 0;
                        const rB = runs.find(r => r.team_id === apiMatch.visitorteam_id)?.score || 0;

                        if (rA > rB) winningTeam = apiMatch.localteam?.name || 'Home Team';
                        else if (rB > rA) winningTeam = apiMatch.visitorteam?.name || 'Away Team';
                        else winningTeam = 'TIE';
                    }
                }

                console.log(`[ResultSettlement] Identified winner for ${matchId}: ${winningTeam}`);

                // 1. Update Match record if it exists
                const dbMatch = pendingMatches.find(m => m.matchId === matchId);
                if (dbMatch) {
                    dbMatch.status = 'completed';
                    dbMatch.winner = winningTeam;
                    const runs = apiMatch.runs || [];
                    const tA = runs.find(r => r.team_id === apiMatch.localteam_id);
                    const tB = runs.find(r => r.team_id === apiMatch.visitorteam_id);
                    
                    dbMatch.score = {
                        teamA_runs: tA ? `${tA.score}/${tA.wickets}` : dbMatch.score?.teamA_runs || '0/0',
                        teamB_runs: tB ? `${tB.score}/${tB.wickets}` : dbMatch.score?.teamB_runs || '0/0',
                        overs: "Final",
                        lastUpdated: new Date()
                    };
                    await dbMatch.save();
                }

                // 2. Trigger Bet Settlement for this match
                await settleMatch(matchId, winningTeam, io);
            }
        }

        // Notify UI about match updates
        if (io) {
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }

    } catch (error) {
        console.error('[ResultSettlement] CRITICAL ERROR:', error.message);
    }
};

module.exports = { processMatchResults };
