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
        // 1. Fetch live scores from API with balls for "This Over" logic
        const response = await getData('livescores', {
            include: 'runs,balls,scoreboards,localteam,visitorteam,league'
        });

        if (!response || !Array.isArray(response.data) || response.data.length === 0) {
            return;
        }

        let updatedCount = 0;

        for (const liveData of response.data) {
            const matchId = liveData.id.toString();
            let matchInDb = await Match.findOne({ matchId });

            if (!matchInDb) {
                // Upsert new live match if it was missed by matchService filtering
                matchInDb = await Match.create({
                    matchId: matchId,
                    leagueId: liveData.league_id,
                    teamA: liveData.localteam?.name || 'Local Team',
                    teamB: liveData.visitorteam?.name || 'Visitor Team',
                    league: liveData.league?.name || 'Unknown League',
                    startTime: new Date(liveData.starting_at || Date.now()),
                    status: 'live',
                    sportKey: 'cricket_international',
                    lastUpdated: new Date()
                });
                console.log(`[ScoreService] Automatically added missing LIVE match: ${matchInDb.teamA} v ${matchInDb.teamB}`);
            }

            const runs = liveData.runs || [];
            const balls = liveData.balls || [];
            
            // Get current and previous innings
            const currentInnings = runs.length > 0 ? runs[runs.length - 1] : null;
            const prevInnings = runs.length > 1 ? runs[runs.length - 2] : null;

            const currentScore = currentInnings ? currentInnings.score : 0;
            const currentWickets = currentInnings ? currentInnings.wickets : 0;
            const currentOvers = currentInnings ? currentInnings.overs : (matchInDb.score?.overs || "0.0");

            // Calculate CRR (Current Run Rate)
            const calculateCRR = (s, o) => {
                const overParts = String(o).split('.');
                const totalBalls = (parseInt(overParts[0]) * 6) + (parseInt(overParts[1]) || 0);
                if (totalBalls === 0) return "0.00";
                return ((s / totalBalls) * 6).toFixed(2);
            };

            const crr = calculateCRR(currentScore, currentOvers);

            // Calculate Target & RRR
            let target = 0;
            let rrr = "0.00";
            let remRuns = 0;
            let remBalls = 0;

            if (prevInnings && currentInnings) {
                target = prevInnings.score + 1;
                remRuns = target - currentScore;
                
                // Assuming T20 for rem balls if not specified, or use stage/type if available
                // Sportmonks v2 fixture has 'type', e.g. 'T20', 'ODI'
                const totalOvers = liveData.type === 'ODI' ? 50 : (liveData.type === 'T20' || liveData.type === 'T20I' ? 20 : 0);
                
                if (totalOvers > 0) {
                    const overParts = String(currentOvers).split('.');
                    const ballsBowled = (parseInt(overParts[0]) * 6) + (parseInt(overParts[1]) || 0);
                    remBalls = (totalOvers * 6) - ballsBowled;
                    
                    if (remBalls > 0) {
                        rrr = ((remRuns / remBalls) * 6).toFixed(2);
                    } else if (remRuns <= 0) {
                        rrr = "0.00";
                    } else {
                        rrr = "∞";
                    }
                }
            }

            // "This Over" logic
            // Get balls from the current over (e.g. if overs is 7.5, current over is 8)
            const currentOverNumber = Math.ceil(parseFloat(currentOvers)) || 1;
            const thisOverBalls = balls
                .filter(b => b.ball >= (currentOverNumber - 1) && b.ball < currentOverNumber)
                .sort((a, b) => a.ball - b.ball)
                .map(b => {
                    if (b.score?.is_wicket || b.batsmanout_id) return 'W';
                    const runs = b.score?.runs || 0;
                    const isExtra = b.score?.bye > 0 || b.score?.leg_bye > 0 || b.score?.noball > 0 || (b.score?.name && b.score.name.toLowerCase().includes('wide'));
                    if (isExtra) return `${runs} (Ex)`;
                    return String(runs);
                });

            // Map runs to teams for DB storage
            const teamARunsObj = runs.find(r => r.team_id === liveData.localteam_id);
            const teamBRunsObj = runs.find(r => r.team_id === liveData.visitorteam_id);

            const teamA_score = teamARunsObj ? `${teamARunsObj.score}/${teamARunsObj.wickets}` : (matchInDb.score?.teamA_runs || "0/0");
            const teamB_score = teamBRunsObj ? `${teamBRunsObj.score}/${teamBRunsObj.wickets}` : (matchInDb.score?.teamB_runs || "0/0");

            // Determine if match is finished
            const completedStatuses = ['Finished', 'Aborted', 'No Result', 'Abandoned', 'Completed', 'Ended', 'Aban.', 'Canc.'];
            const isFinished = completedStatuses.includes(liveData.status);
            let winner = matchInDb.winner;

            if (isFinished) {
                if (['Finished', 'Completed', 'Ended'].includes(liveData.status)) {
                    if (liveData.winner_team_id === liveData.localteam_id) winner = matchInDb.teamA;
                    else if (liveData.winner_team_id === liveData.visitorteam_id) winner = matchInDb.teamB;
                    else {
                        const rA = teamARunsObj?.score || 0;
                        const rB = teamBRunsObj?.score || 0;
                        if (rA > rB) winner = matchInDb.teamA;
                        else if (rB > rA) winner = matchInDb.teamB;
                        else winner = 'TIE';
                    }
                } else {
                    winner = 'VOID';
                }
            }

            const hasChanged = true; // Forcing update to ensure all fields are populated initially

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
                                target:     target,
                                runRate:    crr,
                                reqRunRate: rrr,
                                thisOver:   thisOverBalls,
                                remRuns:    remRuns,
                                remBalls:   remBalls,
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
                    score:   currentScore,
                    overs:   currentOvers,
                    wickets: currentWickets,
                    status:  isFinished ? 'completed' : 'live',
                    teamA_runs: teamA_score,
                    teamB_runs: teamB_score,
                    target:     target,
                    runRate:    crr,
                    reqRunRate: rrr,
                    thisOver:   thisOverBalls,
                    remRuns:    remRuns,
                    remBalls:   remBalls
                });
            }
        }
        
        // 2. Handle matches marked 'live' in DB but NOT in the current API response
        const liveMatchIdsFromApi = response.data.map(m => m.id.toString());
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
            console.log(`[ScoreService] Updated detailed scores for ${updatedCount} matches.`);
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }

    } catch (error) {
        console.error('[ScoreService] Error updating scores:', error.message);
    }
};

module.exports = { updateLiveScores };

