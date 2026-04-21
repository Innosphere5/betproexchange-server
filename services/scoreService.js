const Match = require('../models/Match');
const { getData } = require('./apiManager');

/**
 * updateLiveScores
 * 
 * Migrated to Sportmonks Cricket API v2.0.
 * Fetches all current live scores in one call.
 * Extracts runs/wickets/overs from the 'runs' include.
 */
const updateLiveScores = async (io) => {
    try {
        // 1. Fetch live scores from API
        // Sportmonks Param: include=runs,localteam,visitorteam
        const response = await getData('livescores', {
            include: 'runs,localteam,visitorteam'
        });

        if (!response || !Array.isArray(response.data) || response.data.length === 0) {
            // If no live matches from API, check if we have any 'live' matches in DB to sync
            return;
        }

        let updatedCount = 0;

        for (const liveData of response.data) {
            const matchId = liveData.id.toString();
            const matchInDb = await Match.findOne({ matchId });

            if (!matchInDb) continue;

            const runs = liveData.runs || [];
            
            // Map runs to teams
            // localteam is usually teamA, visitorteam is teamB
            const teamARunsObj = runs.find(r => r.team_id === liveData.localteam_id);
            const teamBRunsObj = runs.find(r => r.team_id === liveData.visitorteam_id);

            const teamA_score = teamARunsObj ? `${teamARunsObj.score}/${teamARunsObj.wickets}` : matchInDb.score?.teamA_runs;
            const teamB_score = teamBRunsObj ? `${teamBRunsObj.score}/${teamBRunsObj.wickets}` : matchInDb.score?.teamB_runs;
            // Use the highest overs from both teams as the current progress
            const currentOvers = teamARunsObj?.overs || teamBRunsObj?.overs || matchInDb.score?.overs || "0.0";

            const hasChanged = 
                teamA_score !== matchInDb.score?.teamA_runs || 
                teamB_score !== matchInDb.score?.teamB_runs ||
                currentOvers !== matchInDb.score?.overs;

            if (hasChanged) {
                await Match.updateOne(
                    { matchId },
                    {
                        $set: {
                            status: 'live', // Force status to live if scores are being received
                            score: {
                                teamA_runs: teamA_score,
                                teamB_runs: teamB_score,
                                overs:      currentOvers,
                                lastUpdated: new Date()
                            },
                            lastUpdated: new Date()
                        }
                    }
                );
                updatedCount++;
            }
        }

        if (updatedCount > 0 && io) {
            console.log(`[ScoreService] Updated scores for ${updatedCount} matches.`);
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }

    } catch (error) {
        console.error('[ScoreService] Error updating scores:', error.message);
    }
};

module.exports = { updateLiveScores };

