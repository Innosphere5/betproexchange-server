const Match = require('../models/Match');
const { getData } = require('./apiManager');
const { getOrInitializeMatchState, advanceCricketState } = require('./cricketEngine');

const normalizeScoreValue = (value, fallback = 0) => {
    if (value === null || value === undefined || value === '') return fallback;
    return value;
};

const normalizeScoreText = (value, fallback = '0.0') => {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
};

/**
 * extractLiveScorePayload
 * 
 * Computes realistic and comprehensive cricket live score metrics
 * (overs, CRR, RRR, target, ball-by-ball thisOver, remaining runs/balls).
 */
const extractLiveScorePayload = (liveData, existingScore = {}) => {
    const matchId = liveData?.fixtureId;
    if (!matchId) {
        return {
            teamA_runs: "0/0",
            teamB_runs: "0/0",
            overs: "0.0",
            wickets: 0,
            target: 0,
            runRate: "0.00",
            reqRunRate: "0.00",
            thisOver: [],
            remRuns: 0,
            remBalls: 0
        };
    }

    const state = getOrInitializeMatchState(matchId, liveData, existingScore);
    const computed = advanceCricketState(state, liveData);

    return {
        teamA_runs: computed.teamA_runs,
        teamB_runs: computed.teamB_runs,
        overs: computed.overs,
        wickets: computed.wickets,
        target: computed.target,
        runRate: computed.runRate,
        reqRunRate: computed.reqRunRate,
        thisOver: computed.thisOver,
        remRuns: computed.remRuns,
        remBalls: computed.remBalls
    };
};

/**
 * updateLiveScores
 * 
 * Migrated to oddspapi REST API (v5.oddspapi.io) + Cricket Engine.
 * Fetches live fixtures from /fixtures/live endpoint.
 * Computes in-play details and emits real-time updates via Socket.IO.
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
            const teamA_score = parsedScore.teamA_runs;
            const teamB_score = parsedScore.teamB_runs;

            // Determine if match is finished
            const p1Total = parseInt(teamA_score.split('/')[0], 10) || 0;
            const p2Total = parseInt(teamB_score.split('/')[0], 10) || 0;

            const isApiFinished = liveData.status?.statusName === 'Finished' || 
                                  liveData.status?.statusId === 2 ||
                                  liveData.trueEndTime != null;

            const isTargetReached = parsedScore.target > 0 && 
                                    ((p1Total >= parsedScore.target && p1Total > p2Total) || 
                                     (p2Total >= parsedScore.target && p2Total > p1Total));

            const isBallsExhausted = parsedScore.target > 0 && parsedScore.remBalls === 0;

            const isFinished = isApiFinished || isTargetReached || isBallsExhausted;

            let winner = matchInDb.winner;

            if (isFinished) {
                if (p1Total > p2Total) winner = matchInDb.teamA;
                else if (p2Total > p1Total) winner = matchInDb.teamB;
                else winner = 'TIE';
            }

            const currentStatus = isFinished ? 'completed' : 'live';
            const oversDisplay = isFinished ? "Final" : parsedScore.overs;

            const hasChanged = (
                matchInDb.score?.teamA_runs !== teamA_score ||
                matchInDb.score?.teamB_runs !== teamB_score ||
                matchInDb.score?.overs !== oversDisplay ||
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
                                overs:      oversDisplay,
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
                    matchId:    matchId,
                    score:      p1Total,
                    overs:      oversDisplay,
                    wickets:    parsedScore.wickets,
                    status:     currentStatus,
                    teamA_runs: teamA_score,
                    teamB_runs: teamB_score,
                    target:     parsedScore.target,
                    runRate:    parsedScore.runRate,
                    reqRunRate: parsedScore.reqRunRate,
                    thisOver:   parsedScore.thisOver,
                    remRuns:    parsedScore.remRuns,
                    remBalls:   parsedScore.remBalls
                });

                const fancyMarketsService = require('./fancyMarketsService');
                fancyMarketsService.handleLiveMatchOdds(matchId, io);
            }
        }
        
        // 2. Handle matches marked 'live' in DB but NOT in the current API response
        const liveMatchIdsFromApi = response.map(m => m.fixtureId);
        const staleMatches = await Match.find({ 
            status: 'live', 
            matchId: { $nin: liveMatchIdsFromApi } 
        });

        for (const match of staleMatches) {
            // If match started more than 4 hours ago and is not in live feed, mark as completed
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
            if (match.startTime < fourHoursAgo) {
                console.log(`[ScoreService] 🏁 Marking stale live match as completed: ${match.teamA} v ${match.teamB}`);
                await Match.updateOne({ matchId: match.matchId }, { $set: { status: 'completed' } });
                updatedCount++;
            }
        }

        if (updatedCount > 0) {
            console.log(`[ScoreService] Updated live scores for ${updatedCount} matches.`);
        }

    } catch (error) {
        console.error('[ScoreService] Error updating scores:', error.message);
    }
};

module.exports = { updateLiveScores, extractLiveScorePayload };
