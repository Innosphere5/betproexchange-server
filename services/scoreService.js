const Match = require('../models/Match');
const { getData } = require('./apiManager');

/**
 * updateLiveScores
 * 
 * Migrated to oddspapi REST API (v5.oddspapi.io).
 * Fetches live fixtures from /fixtures/live endpoint.
 * Extracts participant scores from the oddspapi scores object.
 */
const updateLiveScores = async (io) => {
    try {
        // 1. Fetch live fixtures from oddspapi
        const response = await getData('fixtures/live');

        if (!response || !Array.isArray(response) || response.length === 0) {
            return;
        }

        let updatedCount = 0;

        for (const liveData of response) {
            const matchId = liveData.fixtureId;
            let matchInDb = await Match.findOne({ matchId });

            if (!matchInDb) {
                // Upsert new live match if it was missed by matchService
                matchInDb = await Match.create({
                    matchId: matchId,
                    tournamentId: liveData.tournament?.tournamentId || null,
                    teamA: liveData.participants?.participant1Name || 'Team 1',
                    teamB: liveData.participants?.participant2Name || 'Team 2',
                    league: liveData.tournament?.tournamentName || 'Unknown League',
                    startTime: new Date((liveData.startTime || Math.floor(Date.now() / 1000)) * 1000),
                    status: 'live',
                    sportKey: 'cricket_international',
                    lastUpdated: new Date()
                });
                console.log(`[ScoreService] Automatically added missing LIVE match: ${matchInDb.teamA} v ${matchInDb.teamB}`);
            }

            // Extract scores from oddspapi format
            const scores = liveData.scores || {};
            const resultScore = scores.result || {};
            const p1Score = resultScore.participant1Score || 0;
            const p2Score = resultScore.participant2Score || 0;

            // oddspapi provides total runs per team in scores.result
            // For cricket, format as "runs/wickets" — oddspapi doesn't provide wickets separately
            // so we use the total score format
            const teamA_score = `${p1Score}`;
            const teamB_score = `${p2Score}`;

            // Determine if match is finished
            const isFinished = liveData.status?.statusName === 'Finished' || 
                               liveData.status?.statusId === 2 ||
                               liveData.trueEndTime != null;

            let winner = matchInDb.winner;

            if (isFinished) {
                if (p1Score > p2Score) winner = matchInDb.teamA;
                else if (p2Score > p1Score) winner = matchInDb.teamB;
                else winner = 'TIE';
            }

            const currentStatus = isFinished ? 'completed' : 'live';

            const hasChanged = (
                matchInDb.score?.teamA_runs !== teamA_score ||
                matchInDb.score?.teamB_runs !== teamB_score ||
                matchInDb.status !== currentStatus
            );

            if (hasChanged) {
                await Match.updateOne(
                    { matchId },
                    {
                        $set: {
                            status: currentStatus,
                            winner: winner,
                            score: {
                                teamA_runs: teamA_score,
                                teamB_runs: teamB_score,
                                overs:      isFinished ? "Final" : (matchInDb.score?.overs || "0.0"),
                                wickets:    matchInDb.score?.wickets || 0,
                                target:     matchInDb.score?.target || 0,
                                runRate:    matchInDb.score?.runRate || "0.00",
                                reqRunRate: matchInDb.score?.reqRunRate || "0.00",
                                thisOver:   matchInDb.score?.thisOver || [],
                                remRuns:    matchInDb.score?.remRuns || 0,
                                remBalls:   matchInDb.score?.remBalls || 0,
                                lastUpdated: new Date()
                            },
                            lastUpdated: new Date()
                        }
                    }
                );
                updatedCount++;
            }

            if (io) {
                io.emit('live_score_update', {
                    matchId: matchId,
                    score:   p1Score,
                    overs:   isFinished ? "Final" : (matchInDb.score?.overs || "0.0"),
                    wickets: matchInDb.score?.wickets || 0,
                    status:  currentStatus,
                    teamA_runs: teamA_score,
                    teamB_runs: teamB_score,
                    target:     matchInDb.score?.target || 0,
                    runRate:    matchInDb.score?.runRate || "0.00",
                    reqRunRate: matchInDb.score?.reqRunRate || "0.00",
                    thisOver:   matchInDb.score?.thisOver || [],
                    remRuns:    matchInDb.score?.remRuns || 0,
                    remBalls:   matchInDb.score?.remBalls || 0
                });
            }
        }
        
        // 2. Handle matches marked 'live' in DB but NOT in the current API response
        const liveMatchIdsFromApi = response.map(m => m.fixtureId);
        const staleMatches = await Match.find({ 
            status: 'live', 
            matchId: { $nin: liveMatchIdsFromApi } 
        });

        for (const match of staleMatches) {
            // If match started more than 8 hours ago and is not in live feed, mark as completed
            const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
            if (match.startTime < eightHoursAgo) {
                console.log(`[ScoreService] 🏁 Marking stale live match as completed: ${match.teamA} v ${match.teamB}`);
                await Match.updateOne({ matchId: match.matchId }, { $set: { status: 'completed' } });
                updatedCount++;
            }
        }

        if (updatedCount > 0 && io) {
            console.log(`[ScoreService] Updated scores for ${updatedCount} matches.`);
        }

    } catch (error) {
        console.error('[ScoreService] Error updating scores:', error.message);
    }
};

module.exports = { updateLiveScores };
