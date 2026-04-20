const cron = require('node-cron');
const Match = require('../models/Match');
const { getEvents } = require('../services/apiManager');

/**
 * Live Score Update Job
 * 
 * Runs every 20 seconds.
 * Strictly follows the requirements:
 * 1. Checks for live matches in DB first.
 * 2. If none, exits (no API call).
 * 3. If exist, calls Odds API ONCE for the prioritized league.
 * 4. Updates DB atomically.
 */
const initLiveScoreJob = (io) => {
    // Cron schedule: every 20 seconds
    cron.schedule('*/20 * * * * *', async () => {
        try {
            // 1. Query live matches (limit 2 as per rule)
            const liveMatches = await Match.find({ status: 'live' })
                .sort({ startTime: -1 })
                .limit(2);

            if (liveMatches.length === 0) {
                // Log only occasionally or in debug to keep logs clean
                // console.log('[LiveScoreJob] Skipped: No live matches found.');
                return;
            }

            // 2. Identify prioritized sport key
            // We use the first live match's sportKey to make exactly ONE API call
            const primarySportKey = liveMatches[0].sportKey || 'cricket_ipl';

            console.log(`[LiveScoreJob] Calling API for league: ${primarySportKey}`);

            // 3. Call Odds API (v4 scores endpoint via apiManager)
            const allScoreData = await getEvents(primarySportKey, 'scores');

            if (!Array.isArray(allScoreData) || allScoreData.length === 0) {
                console.warn(`[LiveScoreJob] No score data returned from API for ${primarySportKey}`);
                return;
            }

            let updatedCount = 0;

            // 4. Update MongoDB
            for (const match of liveMatches) {
                const freshData = allScoreData.find(e => e.id?.toString() === match.matchId);

                if (freshData && freshData.scores) {
                    // Extract scores: [{ name: "Team A", score: "..." }, ...]
                    const homeScoreObj = freshData.scores.find(s => s.name === freshData.home_team);
                    const awayScoreObj = freshData.scores.find(s => s.name === freshData.away_team);

                    // Note: Odds API v4 cricket scores usually contain runs/wickets and sometimes overs in the 'score' string
                    // We parse or use as is based on availability
                    const newScore = {
                        teamA_runs: homeScoreObj ? homeScoreObj.score : match.score?.teamA_runs,
                        teamB_runs: awayScoreObj ? awayScoreObj.score : match.score?.teamB_runs,
                        overs: match.score?.overs || "0.0", // Overs are rarely separate in v4, usually in score string
                        lastUpdated: new Date()
                    };

                    await Match.updateOne(
                        { matchId: match.matchId },
                        { 
                            $set: { 
                                score: newScore,
                                lastUpdated: new Date()
                            } 
                        }
                    );
                    updatedCount++;
                }
            }

            if (updatedCount > 0) {
                console.log(`[LiveScoreJob] DB Updated: ${updatedCount} matches updated.`);
                
                // Emit update via Socket.io for immediate UI reflection
                const allMatches = await Match.find().sort({ startTime: 1 });
                io.emit('matches_updated', allMatches);
            }

        } catch (error) {
            console.error('[LiveScoreJob] Error:', error.message);
        }
    });

    console.log('✅ LiveScoreJob initialized (20s interval)');
};

module.exports = { initLiveScoreJob };
