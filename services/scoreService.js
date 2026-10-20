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
        remBalls: computed.remBalls,
        battingTeam: computed.battingTeam,
        battingTeamName: computed.battingTeamName,
        innings: computed.innings,
        periods: computed.scoresBreakdown || {}
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
                const { shouldIncludeFixture } = require('./fixtureFilter');
                if (!shouldIncludeFixture(liveData)) {
                    continue;
                }
                // Upsert new live match if it was missed by matchService and passes filter
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
                console.log(`[ScoreService] Automatically added verified real LIVE match: ${matchInDb.teamA} v ${matchInDb.teamB}`);
            }

            const parsedScore = extractLiveScorePayload(liveData, matchInDb.score || {});
            const teamA_score = parsedScore.teamA_runs;
            const teamB_score = parsedScore.teamB_runs;

            // Determine if match is finished
            const p1Total = parseInt(teamA_score.split('/')[0], 10) || 0;
            const p2Total = parseInt(teamB_score.split('/')[0], 10) || 0;

            const isLiveStatus = Boolean(liveData.status?.live === true || 
                                          liveData.status?.statusName === 'Live' || 
                                          liveData.status?.statusId === 1);

            const isApiFinished = !isLiveStatus && (
                                  liveData.status?.statusName === 'Finished' || 
                                  liveData.status?.statusId === 2
            );

            const isTargetReached = parsedScore.target > 0 && (
                (parsedScore.battingTeam === 'teamB' && p2Total >= parsedScore.target) ||
                (parsedScore.battingTeam === 'teamA' && p1Total >= parsedScore.target)
            );

            const isBallsExhausted = parsedScore.target > 0 && parsedScore.remBalls === 0 && parsedScore.remRuns > 0;

            const isFinished = !isLiveStatus && (isApiFinished || isTargetReached || isBallsExhausted);

            let winner = null; // Always derive winner fresh — never carry stale DB value for live matches

            if (isFinished) {
                if (parsedScore.target > 0) {
                    if (isTargetReached) {
                        winner = parsedScore.battingTeam === 'teamB' ? matchInDb.teamB : matchInDb.teamA;
                    } else if (p1Total > p2Total) {
                        winner = matchInDb.teamA;
                    } else if (p2Total > p1Total) {
                        winner = matchInDb.teamB;
                    } else {
                        winner = 'TIE';
                    }
                } else {
                    if (p1Total > p2Total) winner = matchInDb.teamA;
                    else if (p2Total > p1Total) winner = matchInDb.teamB;
                    else winner = 'TIE';
                }
            }
            // If match is LIVE, winner must be null — prevents UI from showing "MATCH COMPLETED"

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
                matchInDb.score?.battingTeam !== parsedScore.battingTeam ||
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
                                battingTeam: parsedScore.battingTeam,
                                battingTeamName: parsedScore.battingTeamName,
                                innings:    parsedScore.innings,
                                periods:    parsedScore.periods,
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
                    score:      parsedScore.battingTeam === 'teamB' ? p2Total : p1Total,
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
                    remBalls:   parsedScore.remBalls,
                    battingTeam: parsedScore.battingTeam,
                    battingTeamName: parsedScore.battingTeamName,
                    innings:    parsedScore.innings,
                    periods:    parsedScore.periods
                });

                const fancyMarketsService = require('./fancyMarketsService');
                fancyMarketsService.handleLiveMatchOdds(matchId, io);
            }
        }
        
        // 2. Handle matches marked 'live' in DB but NOT in the current API response
        //    IMPORTANT: /fixtures/live only returns ~5 results, so omission does NOT mean finished.
        //    We must do a targeted fixture lookup to verify the actual status before settling.
        const liveMatchIdsFromApi = response.map(m => m.fixtureId);
        const staleMatches = await Match.find({ 
            status: 'live', 
            matchId: { $nin: liveMatchIdsFromApi } 
        });

        if (staleMatches.length > 0) {
            console.log(`[ScoreService] 🔍 Found ${staleMatches.length} DB-live matches not in /fixtures/live. Verifying via targeted lookup...`);
            const confirmedStaleIds = [];
            for (const staleMatch of staleMatches) {
                try {
                    const verifyRes = await getData('fixtures', {
                        params: { fixtureIds: staleMatch.matchId }
                    });
                    if (Array.isArray(verifyRes) && verifyRes.length > 0) {
                        const f = verifyRes[0];
                        const stillLive = Boolean(f.status?.live || f.status?.statusId === 1 || f.status?.statusName === 'Live');
                        const isFinished = !stillLive && (f.status?.statusName === 'Finished' || f.status?.statusId === 2);
                        if (stillLive) {
                            // Match is still live — just not in the small /fixtures/live response. Process its score.
                            const parsedScore = extractLiveScorePayload(f, staleMatch.score || {});
                            const p1 = parseInt(String(parsedScore.teamA_runs).split('/')[0], 10) || 0;
                            const p2 = parseInt(String(parsedScore.teamB_runs).split('/')[0], 10) || 0;
                            await Match.updateOne(
                                { matchId: staleMatch.matchId },
                                { $set: {
                                    status: 'live',
                                    winner: null, // Clear any stale winner
                                    score: {
                                        teamA_runs: parsedScore.teamA_runs,
                                        teamB_runs: parsedScore.teamB_runs,
                                        overs: parsedScore.overs,
                                        wickets: parsedScore.wickets,
                                        target: parsedScore.target,
                                        runRate: parsedScore.runRate,
                                        reqRunRate: parsedScore.reqRunRate,
                                        thisOver: parsedScore.thisOver,
                                        remRuns: parsedScore.remRuns,
                                        remBalls: parsedScore.remBalls,
                                        battingTeam: parsedScore.battingTeam,
                                        battingTeamName: parsedScore.battingTeamName,
                                        innings: parsedScore.innings,
                                        periods: parsedScore.periods,
                                        lastUpdated: new Date()
                                    },
                                    lastUpdated: new Date()
                                }}
                            );
                            if (io) {
                                io.emit('live_score_update', {
                                    matchId: staleMatch.matchId,
                                    score: parsedScore.battingTeam === 'teamB' ? p2 : p1,
                                    overs: parsedScore.overs,
                                    wickets: parsedScore.wickets,
                                    status: 'live',
                                    teamA_runs: parsedScore.teamA_runs,
                                    teamB_runs: parsedScore.teamB_runs,
                                    target: parsedScore.target,
                                    runRate: parsedScore.runRate,
                                    reqRunRate: parsedScore.reqRunRate,
                                    thisOver: parsedScore.thisOver,
                                    remRuns: parsedScore.remRuns,
                                    remBalls: parsedScore.remBalls,
                                    battingTeam: parsedScore.battingTeam,
                                    battingTeamName: parsedScore.battingTeamName,
                                    innings: parsedScore.innings,
                                    periods: parsedScore.periods
                                });
                            }
                            console.log(`[ScoreService] ✅ ${staleMatch.teamA} v ${staleMatch.teamB} confirmed STILL LIVE via targeted lookup.`);
                        } else if (isFinished) {
                            confirmedStaleIds.push(staleMatch.matchId);
                            console.log(`[ScoreService] 🏁 ${staleMatch.teamA} v ${staleMatch.teamB} confirmed FINISHED via targeted lookup.`);
                        } else {
                            console.log(`[ScoreService] ⏳ ${staleMatch.teamA} v ${staleMatch.teamB} status: ${f.status?.statusName} — not settling yet.`);
                        }
                    }
                } catch (err) {
                    console.warn(`[ScoreService] Could not verify fixture ${staleMatch.matchId}:`, err.message);
                }
            }
            if (confirmedStaleIds.length > 0) {
                console.log(`[ScoreService] 🏁 ${confirmedStaleIds.length} matches confirmed finished. Triggering settlement...`);
                const { processMatchResults } = require('./resultSettlementService');
                processMatchResults(io).catch(err => console.error('[ScoreService] Settlement trigger error:', err.message));
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
