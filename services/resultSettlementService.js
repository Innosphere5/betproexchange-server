const Match = require('../models/Match');
const Bet = require('../models/Bet');
const { getData } = require('./apiManager');
const { settleMatch } = require('./settlementService');

/**
 * processMatchResults
 * 
 * Uses oddspapi REST API to fetch recently completed fixtures,
 * determine the winner, and trigger bet settlement.
 * 
 * ENHANCED: Also checks for results of every "MATCHED" bet in the DB, 
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

        // Fetch today's fixtures from oddspapi (covers yesterday through tomorrow)
        const yesterdayTs = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
        const tomorrowTs = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);

        console.log(`[ResultSettlement] Fetching fixtures from oddspapi...`);

        const response = await getData('fixtures', {
            params: {
                startTimeFrom: yesterdayTs,
                startTimeTo: tomorrowTs,
            }
        });

        if (!response || !Array.isArray(response)) {
            console.warn('[ResultSettlement] API returned no fixture data.');
            return;
        }

        const apiFixtures = response;
        console.log(`[ResultSettlement] Fetched ${apiFixtures.length} fixtures for the check.`);

        for (const matchId of allIdsToCheck) {
            const apiMatch = apiFixtures.find(f => f.fixtureId === matchId);

            if (!apiMatch) {
                continue;
            }

            // oddspapi statuses: statusId=2 means "Finished"
            const isCompleted = apiMatch.status?.statusName === 'Finished' || 
                                apiMatch.status?.statusId === 2 ||
                                apiMatch.trueEndTime != null;

            if (isCompleted) {
                console.log(`[ResultSettlement] 🏆 Match ${matchId} is ${apiMatch.status?.statusName}.`);

                let winningTeam = 'VOID'; 

                if (apiMatch.status?.statusName === 'Finished') {
                    const p1Score = apiMatch.scores?.result?.participant1Score || 0;
                    const p2Score = apiMatch.scores?.result?.participant2Score || 0;
                    const p1Name = apiMatch.participants?.participant1Name || 'Team 1';
                    const p2Name = apiMatch.participants?.participant2Name || 'Team 2';

                    if (p1Score > p2Score) winningTeam = p1Name;
                    else if (p2Score > p1Score) winningTeam = p2Name;
                    else winningTeam = 'TIE';
                }

                console.log(`[ResultSettlement] Identified winner for ${matchId}: ${winningTeam}`);

                // 1. Update Match record if it exists
                const dbMatch = pendingMatches.find(m => m.matchId === matchId);
                if (dbMatch) {
                    const p1Score = apiMatch.scores?.result?.participant1Score || 0;
                    const p2Score = apiMatch.scores?.result?.participant2Score || 0;

                    dbMatch.status = 'completed';
                    dbMatch.winner = winningTeam;
                    dbMatch.score = {
                        teamA_runs: `${p1Score}`,
                        teamB_runs: `${p2Score}`,
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
