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
 * ENHANCED:
 * 1. Checks all pending matches and ALL un-settled bets in DB.
 * 2. Directly passes fixtureIds to Oddspapi v5 to retrieve official finished status & scores.
 * 3. Handles flexible fixtureId matching (with/without 'id' prefix).
 * 4. Extracts winner from Oddspapi scores (result, fulltime, or period breakdown).
 * 5. Upserts Match record in DB if missing/pruned so UI reflects completed status & winner.
 * 6. Invokes settleMatch which calculates liability/profit, updates wallets, and distributes
 *    P/L up the hierarchy chain to reflect accurately in Daily Report and Final Sheet.
 */
const processMatchResults = async (io) => {
    try {
        console.log('[ResultSettlement] Checking for completed match results...');
        
        // 1. Get IDs from pending/un-resulted matches in DB
        const pendingMatches = await Match.find({
            $or: [
                { status: { $ne: 'completed' } },
                { winner: null },
                { winner: { $exists: false } }
            ]
        });
        const pendingMatchIds = pendingMatches.map(m => m.matchId).filter(Boolean);

        // 2. Get IDs from active/unsettled bets (catches matches that were pruned from DB)
        const activeBets = await Bet.find({
            status: { $in: ['pending', 'MATCHED'] }
        });
        const betMatchIds = [...new Set(activeBets.map(b => b.matchId).filter(Boolean))];

        // Combine unique IDs to check
        const allIdsToCheck = [...new Set([...pendingMatchIds, ...betMatchIds])];

        if (allIdsToCheck.length === 0) {
            console.log('[ResultSettlement] No pending matches or active bets found to check.');
            return;
        }

        console.log(`[ResultSettlement] Found ${allIdsToCheck.length} unique match IDs to check result status:`, allIdsToCheck);

        // 3. Collect API fixtures:
        // A. Direct targeted fetch by fixtureIds (handles fixtures regardless of start date)
        // Format IDs both as original and with/without 'id' prefix to ensure Oddspapi matches
        const formattedFixtureIds = [];
        allIdsToCheck.forEach(id => {
            const raw = String(id).trim();
            if (raw) {
                formattedFixtureIds.push(raw);
                if (raw.startsWith('id')) {
                    formattedFixtureIds.push(raw.replace(/^id/, ''));
                } else {
                    formattedFixtureIds.push(`id${raw}`);
                }
            }
        });

        const uniqueApiIds = [...new Set(formattedFixtureIds)];
        const apiFixturesMap = new Map();

        // Batch in groups of 20 IDs for Oddspapi
        const BATCH_SIZE = 20;
        for (let i = 0; i < uniqueApiIds.length; i += BATCH_SIZE) {
            const chunk = uniqueApiIds.slice(i, i + BATCH_SIZE);
            try {
                const chunkResponse = await getData('fixtures', {
                    params: { fixtureIds: chunk.join(',') }
                });
                if (Array.isArray(chunkResponse)) {
                    chunkResponse.forEach(f => {
                        const fId = String(f.fixtureId || f.id || '');
                        if (fId) {
                            apiFixturesMap.set(fId, f);
                            apiFixturesMap.set(fId.replace(/^id/, ''), f);
                            apiFixturesMap.set(`id${fId.replace(/^id/, '')}`, f);
                        }
                    });
                }
            } catch (err) {
                console.warn(`[ResultSettlement] Failed to fetch fixtures chunk:`, err.message);
            }
        }

        // B. Also fetch general recent fixtures window as a fallback
        const yesterdayTs = Math.floor((Date.now() - 36 * 60 * 60 * 1000) / 1000);
        const tomorrowTs = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);

        try {
            const windowResponse = await getData('fixtures', {
                params: {
                    startTimeFrom: yesterdayTs,
                    startTimeTo: tomorrowTs,
                }
            });
            if (Array.isArray(windowResponse)) {
                windowResponse.forEach(f => {
                    const fId = String(f.fixtureId || f.id || '');
                    if (fId && !apiFixturesMap.has(fId)) {
                        apiFixturesMap.set(fId, f);
                        apiFixturesMap.set(fId.replace(/^id/, ''), f);
                        apiFixturesMap.set(`id${fId.replace(/^id/, '')}`, f);
                    }
                });
            }
        } catch (err) {
            console.warn(`[ResultSettlement] Failed window fetch:`, err.message);
        }

        console.log(`[ResultSettlement] Total API fixtures retrieved for settlement evaluation: ${apiFixturesMap.size}`);

        for (const matchId of allIdsToCheck) {
            const cleanId = String(matchId).replace(/^id/, '');
            const altId = String(matchId).startsWith('id') ? cleanId : `id${cleanId}`;

            const apiMatch = apiFixturesMap.get(String(matchId)) ||
                             apiFixturesMap.get(cleanId) ||
                             apiFixturesMap.get(altId);

            if (!apiMatch) {
                continue;
            }

            const statusObj = apiMatch.status || {};
            const statusName = String(statusObj.statusName || '').toLowerCase().trim();
            const statusId = Number(statusObj.statusId);

            // oddspapi statuses: statusId=2 means "Finished", statusId=3 means "Cancelled"
            const isCompleted = statusName === 'finished' || 
                                statusName === 'ended' ||
                                statusId === 2 ||
                                apiMatch.trueEndTime != null;

            const isCancelled = statusName === 'cancelled' ||
                                statusName === 'abandoned' ||
                                statusId === 3;

            // Handle reissuedFixtureId for postponed/re-listed matches
            if (isCancelled) {
                const reissuedId = apiMatch.reissuedFixtureId;
                if (reissuedId) {
                    console.log(`[ResultSettlement] 🔁 Match ${matchId} fixture reissued as ${reissuedId}. Carrying over bets...`);
                    await Match.updateMany(
                        { matchId: { $in: [matchId, altId] } },
                        { $set: { reissuedFixtureId: reissuedId, oddsApiEventId: reissuedId, lastUpdated: new Date() } }
                    );
                    continue;
                }

                const startTimeMs = apiMatch.startTime ? apiMatch.startTime * 1000 : 0;
                const hoursSinceStart = startTimeMs > 0 ? (Date.now() - startTimeMs) / (1000 * 60 * 60) : 0;

                if (hoursSinceStart > 12) {
                    console.log(`[ResultSettlement] ⛔ Permanent cancellation confirmed for ${matchId}. Refunding bets.`);
                    await Match.updateMany(
                        { matchId: { $in: [matchId, altId] } },
                        { $set: { status: 'completed', winner: 'REFUND', marketStatus: 'CLOSED', lastUpdated: new Date() } }
                    );
                    await settleMatch(matchId, 'REFUND', io);
                }
                continue;
            }

            if (isCompleted) {
                console.log(`[ResultSettlement] 🏆 Match ${matchId} (${apiMatch.participants?.participant1Name} v ${apiMatch.participants?.participant2Name}) is FINISHED.`);

                // Extract scores
                const scoresObj = apiMatch.scores || {};
                const resultScore = scoresObj.result || scoresObj.fulltime || scoresObj['0'] || {};
                let p1Score = Number(resultScore.participant1Score || 0);
                let p2Score = Number(resultScore.participant2Score || 0);

                // Fallback score scan across periods if result/fulltime not explicitly set
                if (p1Score === 0 && p2Score === 0) {
                    for (const [key, val] of Object.entries(scoresObj)) {
                        if (val && typeof val === 'object') {
                            const s1 = Number(val.participant1Score || 0);
                            const s2 = Number(val.participant2Score || 0);
                            if (s1 > p1Score) p1Score = s1;
                            if (s2 > p2Score) p2Score = s2;
                        }
                    }
                }

                let dbMatch = await Match.findOne({ matchId: { $in: [matchId, altId] } });
                const sampleBet = activeBets.find(b => b.matchId === matchId || b.matchId === altId);

                const p1Name = dbMatch?.teamA || apiMatch.participants?.participant1Name || 'Team 1';
                const p2Name = dbMatch?.teamB || apiMatch.participants?.participant2Name || 'Team 2';

                let winningTeam = 'VOID';
                if (p1Score > p2Score) winningTeam = p1Name;
                else if (p2Score > p1Score) winningTeam = p2Name;
                else if (p1Score > 0 && p1Score === p2Score) winningTeam = 'TIE';
                else if (sampleBet && sampleBet.matchName) {
                    // If scores are somehow tie or 0/0, use tie or result from external provider
                    winningTeam = p1Score > p2Score ? p1Name : (p2Score > p1Score ? p2Name : 'TIE');
                }

                console.log(`[ResultSettlement] Identified winner for ${matchId}: "${winningTeam}" (Scores: ${p1Name} ${p1Score} - ${p2Name} ${p2Score})`);

                // Upsert Match record in DB so it permanently shows completed with winner
                const updatedMatch = await Match.findOneAndUpdate(
                    { matchId: { $in: [matchId, altId] } },
                    {
                        $set: {
                            matchId: matchId,
                            oddsApiEventId: apiMatch.fixtureId || apiMatch.id || matchId,
                            teamA: p1Name,
                            teamB: p2Name,
                            league: apiMatch.tournament?.tournamentName || dbMatch?.league || 'Cricket',
                            status: 'completed',
                            winner: winningTeam,
                            score: {
                                teamA_runs: `${p1Score}`,
                                teamB_runs: `${p2Score}`,
                                overs: "Final",
                                lastUpdated: new Date()
                            },
                            marketStatus: 'CLOSED',
                            bookmakerMarketStatus: 'CLOSED',
                            backOddsA: null,
                            layOddsA: null,
                            backOddsB: null,
                            layOddsB: null,
                            bookmakerBackA: null,
                            bookmakerLayA: null,
                            bookmakerBackB: null,
                            bookmakerLayB: null,
                            lastUpdated: new Date()
                        }
                    },
                    { upsert: true, new: true }
                );

                // Trigger Bet Settlement for this match across all parent hierarchies
                await settleMatch(matchId, winningTeam, io);

                if (io && updatedMatch) {
                    io.emit('match_updated', updatedMatch);
                    io.emit('match_settled', {
                        matchId: matchId,
                        winner: winningTeam,
                        score: updatedMatch.score
                    });
                }
            }
        }

        // Notify UI about match list updates
        if (io) {
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }

    } catch (error) {
        console.error('[ResultSettlement] CRITICAL ERROR:', error.message);
    }
};

module.exports = { processMatchResults };
