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
            
            // Get the current innings runs (usually the last one in the array for live matches)
            const currentInnings = runs.length > 0 ? runs[runs.length - 1] : null;
            const currentScore = currentInnings ? currentInnings.score : 0;
            const currentWickets = currentInnings ? currentInnings.wickets : 0;
            const currentOvers = currentInnings ? currentInnings.overs : (matchInDb.score?.overs || "0.0");

            // Map runs to teams for DB storage
            const teamARunsObj = runs.find(r => r.team_id === liveData.localteam_id);
            const teamBRunsObj = runs.find(r => r.team_id === liveData.visitorteam_id);

            const teamA_score = teamARunsObj ? `${teamARunsObj.score}/${teamARunsObj.wickets}` : matchInDb.score?.teamA_runs;
            const teamB_score = teamBRunsObj ? `${teamBRunsObj.score}/${teamBRunsObj.wickets}` : matchInDb.score?.teamB_runs;

            // Determine if match is finished
            const completedStatuses = ['Finished', 'Aborted', 'No Result', 'Abandoned', 'Completed', 'Ended'];
            const isFinished = completedStatuses.includes(liveData.status);
            let winner = matchInDb.winner;

            if (isFinished) {
                // Determine winner by higher score as requested if it's Finished
                if (['Finished', 'Completed', 'Ended'].includes(liveData.status)) {
                    const rA = teamARunsObj?.score || 0;
                    const rB = teamBRunsObj?.score || 0;
                    if (liveData.winner_team_id === liveData.localteam_id) winner = matchInDb.teamA;
                    else if (liveData.winner_team_id === liveData.visitorteam_id) winner = matchInDb.teamB;
                    else if (rA > rB) winner = matchInDb.teamA;
                    else if (rB > rA) winner = matchInDb.teamB;
                    else winner = 'TIE';
                } else {
                    winner = 'VOID';
                }
            }

            const hasChanged = 
                teamA_score !== matchInDb.score?.teamA_runs || 
                teamB_score !== matchInDb.score?.teamB_runs ||
                currentOvers !== matchInDb.score?.overs ||
                currentWickets !== matchInDb.score?.wickets ||
                (isFinished && matchInDb.status !== 'completed');

            if (hasChanged) {
                await Match.updateOne(
                    { matchId },
                    {
                        $set: {
                            status: isFinished ? 'completed' : 'live',
                            winner: winner,
                            score: {
                                teamA_runs: teamA_score,
                                teamB_runs: teamB_score,
                                overs:      isFinished ? "Final" : currentOvers,
                                wickets:    currentWickets,
                                lastUpdated: new Date()
                            },
                            lastUpdated: new Date()
                        }
                    }
                );
                updatedCount++;
            }

            // Emit the specific payload requested by the user for real-time updates
            if (io) {
                // Always emit live_score_update to keep frontend synced
                io.emit('live_score_update', {
                    matchId: matchId,
                    score:   currentScore,
                    overs:   currentOvers,
                    wickets: currentWickets,
                    status:  isFinished ? 'completed' : 'live',
                    teamA_runs: teamA_score,
                    teamB_runs: teamB_score
                });
            }
            
            if (io && isFinished && hasChanged) {
                io.emit('match_result', {
                    matchId: matchId,
                    status: 'completed',
                    winner: winner,
                    finalScore: {
                        teamA: teamA_score,
                        teamB: teamB_score
                    }
                });
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

