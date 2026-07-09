const Match = require('../models/Match');
const { getData } = require('./apiManager');

const normalizeScoreValue = (value, fallback = 0) => {
    if (value === null || value === undefined || value === '') return fallback;
    return value;
};

const normalizeScoreText = (value, fallback = '0.0') => {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number') return String(value);
    return String(value);
};

const extractLiveScorePayload = (liveData, existingScore = {}) => {
    const scores = liveData?.scores || {};
    const resultScore = scores.result || {};

    const p1Score = normalizeScoreValue(resultScore.participant1Score, 0);
    const p2Score = normalizeScoreValue(resultScore.participant2Score, 0);

    const extracted = {
        teamA_runs: String(p1Score),
        teamB_runs: String(p2Score),
        overs: normalizeScoreText(
            resultScore.overs ?? liveData?.clock?.currentTime ?? existingScore?.overs,
            existingScore?.overs || '0.0'
        ),
        wickets: normalizeScoreValue(
            resultScore.wickets ?? existingScore?.wickets,
            existingScore?.wickets || 0
        ),
        target: normalizeScoreValue(
            resultScore.target ?? existingScore?.target,
            existingScore?.target || 0
        ),
        runRate: normalizeScoreText(
            resultScore.runRate ?? existingScore?.runRate,
            existingScore?.runRate || '0.00'
        ),
        reqRunRate: normalizeScoreText(
            resultScore.reqRunRate ?? existingScore?.reqRunRate,
            existingScore?.reqRunRate || '0.00'
        ),
        thisOver: Array.isArray(resultScore.thisOver)
            ? resultScore.thisOver
            : (Array.isArray(existingScore?.thisOver) ? existingScore.thisOver : []),
        remRuns: normalizeScoreValue(
            resultScore.remRuns ?? existingScore?.remRuns,
            existingScore?.remRuns || 0
        ),
        remBalls: normalizeScoreValue(
            resultScore.remBalls ?? existingScore?.remBalls,
            existingScore?.remBalls || 0
        )
    };

    return extracted;
};

/**
 * updateLiveScores
 * 
 * Migrated to oddspapi REST API (v5.oddspapi.io).
 * Fetches live fixtures from /fixtures/live endpoint.
 * Extracts participant scores and available in-play detail from the oddspapi payload.
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

            const parsedScore = extractLiveScorePayload(liveData, matchInDb.score || {});
            const p1Score = parsedScore.teamA_runs;
            const p2Score = parsedScore.teamB_runs;
            const teamA_score = String(p1Score);
            const teamB_score = String(p2Score);

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
                matchInDb.score?.overs !== parsedScore.overs ||
                matchInDb.score?.runRate !== parsedScore.runRate ||
                matchInDb.score?.reqRunRate !== parsedScore.reqRunRate ||
                matchInDb.score?.thisOver?.join(',') !== parsedScore.thisOver.join(',') ||
                matchInDb.score?.remRuns !== parsedScore.remRuns ||
                matchInDb.score?.remBalls !== parsedScore.remBalls ||
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
                                overs:      isFinished ? "Final" : parsedScore.overs,
                                wickets:    parsedScore.wickets,
                                target:     parsedScore.target,
                                runRate:    parsedScore.runRate,
                                reqRunRate: parsedScore.reqRunRate,
                                thisOver:   parsedScore.thisOver,
                                remRuns:    parsedScore.remRuns,
                                remBalls:   parsedScore.remBalls,
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
                    overs:   isFinished ? "Final" : parsedScore.overs,
                    wickets: parsedScore.wickets,
                    status:  currentStatus,
                    teamA_runs: teamA_score,
                    teamB_runs: teamB_score,
                    target:     parsedScore.target,
                    runRate:    parsedScore.runRate,
                    reqRunRate: parsedScore.reqRunRate,
                    thisOver:   parsedScore.thisOver,
                    remRuns:    parsedScore.remRuns,
                    remBalls:   parsedScore.remBalls
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

module.exports = { updateLiveScores, extractLiveScorePayload };
