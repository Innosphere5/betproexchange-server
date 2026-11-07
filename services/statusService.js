const Match = require('../models/Match');
const { settleMatch } = require('./settlementService');

/**
 * Detect format to establish duration ceilings and rules
 */
function getMatchFormatInfo(leagueName = '') {
    const l = String(leagueName || '').toLowerCase();
    if (l.includes('d10') || l.includes('t10') || l.includes('ten10') || l.includes('ecs') || l.includes('ecl')) {
        return { format: 'T10', maxDurationHours: 2.5, maxOvers: 10 };
    }
    if (l.includes('hundred')) {
        return { format: 'Hundred', maxDurationHours: 3.5, maxOvers: 16.4 };
    }
    if (l.includes('odi') || l.includes('one day') || l.includes('50 over') || l.includes('league two') || l.includes('world cup')) {
        return { format: 'ODI', maxDurationHours: 10.0, maxOvers: 50 };
    }
    if (l.includes('test') || l.includes('ranji') || l.includes('shield') || l.includes('trophy')) {
        return { format: 'Test', maxDurationHours: 120.0, maxOvers: 450 };
    }
    return { format: 'T20', maxDurationHours: 5.0, maxOvers: 20 };
}

/**
 * Evaluates whether a live match has ended based on real-time cricket rules,
 * score milestones, or format duration guards.
 */
function evaluateMatchCompletion(match, now) {
    if (match.status !== 'live') return { isCompleted: false };

    const score = match.score || {};
    const statusText = String(score.statusText || '').toLowerCase().trim();
    const oversStr = String(score.overs || '').toLowerCase().trim();

    const teamA_runs = String(score.teamA_runs || '0/0');
    const teamB_runs = String(score.teamB_runs || '0/0');
    const p1Score = parseInt(teamA_runs.split('/')[0], 10) || 0;
    const p1Wickets = parseInt(teamA_runs.split('/')[1], 10) || Number(score.teamA_wickets) || 0;
    const p2Score = parseInt(teamB_runs.split('/')[0], 10) || 0;
    const p2Wickets = parseInt(teamB_runs.split('/')[1], 10) || Number(score.teamB_wickets) || 0;

    const target = Number(score.target || 0);
    const battingTeam = score.battingTeam;
    const innings = Number(score.innings || 1);

    const formatInfo = getMatchFormatInfo(match.league);
    const startTimeMs = match.startTime ? new Date(match.startTime).getTime() : 0;
    const hoursElapsed = startTimeMs > 0 ? (now.getTime() - startTimeMs) / (1000 * 60 * 60) : 0;

    // 1. Explicit API / statusText finished marker
    if (statusText === 'finished' || statusText === 'ended' || statusText === 'completed' || oversStr === 'final') {
        const winner = p1Score > p2Score ? match.teamA : (p2Score > p1Score ? match.teamB : (p1Score > 0 ? 'TIE' : 'VOID'));
        return { isCompleted: true, winner, reason: 'STATUS_TEXT_FINISHED' };
    }

    // 2. Chasing target reached (2nd innings)
    if (target > 0) {
        if (battingTeam === 'teamB' && p2Score >= target) {
            return { isCompleted: true, winner: match.teamB, reason: 'TARGET_CHASED_BY_TEAM_B' };
        }
        if (battingTeam === 'teamA' && p1Score >= target) {
            return { isCompleted: true, winner: match.teamA, reason: 'TARGET_CHASED_BY_TEAM_A' };
        }

        // Chasing team all out (10 wickets down)
        if (battingTeam === 'teamB' && p2Wickets >= 10 && p2Score < target) {
            return { isCompleted: true, winner: match.teamA, reason: 'CHASING_TEAM_B_ALL_OUT' };
        }
        if (battingTeam === 'teamA' && p1Wickets >= 10 && p1Score < target) {
            return { isCompleted: true, winner: match.teamB, reason: 'CHASING_TEAM_A_ALL_OUT' };
        }

        // Remaining balls exhausted in 2nd innings
        if (score.remBalls === 0 && score.remRuns > 0) {
            const winner = p1Score > p2Score ? match.teamA : (p2Score > p1Score ? match.teamB : 'TIE');
            return { isCompleted: true, winner, reason: 'BALLS_EXHAUSTED' };
        }
    }

    // 3. Duration Timeout Guard (exceeds maximum realistic match duration)
    if (hoursElapsed > formatInfo.maxDurationHours) {
        const lastScoreUpdate = score.lastUpdated ? new Date(score.lastUpdated).getTime() : 0;
        const scoreIdleMins = lastScoreUpdate > 0 ? (now.getTime() - lastScoreUpdate) / (1000 * 60) : 999;

        // If match exceeded max duration AND score has been idle for >= 12 mins, it's over
        if (scoreIdleMins >= 12 || hoursElapsed > formatInfo.maxDurationHours + 2) {
            let winner = 'VOID';
            if (p1Score > p2Score) winner = match.teamA;
            else if (p2Score > p1Score) winner = match.teamB;
            else if (p1Score > 0 && p1Score === p2Score) winner = 'TIE';

            return { isCompleted: true, winner, reason: `DURATION_GUARD_EXCEEDED_${formatInfo.format}` };
        }
    }

    return { isCompleted: false };
}

const updateMatchStatuses = async (io) => {
    try {
        const now = new Date();
        const matches = await Match.find({ status: { $ne: 'completed' } });
        let matchChanged = false;

        for (const match of matches) {
            let newStatus = match.status;

            // 1. Upcoming -> Live transition
            if (now >= match.startTime && match.status === 'upcoming') {
                newStatus = 'live';
            }

            // 2. Real-Time Over-Match Detection: Live -> Completed transition
            if (newStatus === 'live') {
                const evalResult = evaluateMatchCompletion(match, now);
                if (evalResult.isCompleted) {
                    console.log(`[StatusService] 🏁 Match ${match.matchId} (${match.teamA} v ${match.teamB}) COMPLETED (${evalResult.reason}). Winner: "${evalResult.winner}"`);
                    newStatus = 'completed';
                    match.winner = evalResult.winner;
                    match.score = match.score || {};
                    match.score.overs = 'Final';
                    match.score.statusText = 'Finished';
                    match.score.lastUpdated = now;
                }
            }

            if (newStatus !== match.status) {
                match.status = newStatus;
                match.lastUpdated = now;
                matchChanged = true;

                // When match goes live: toss market closes
                if (newStatus === 'live') {
                    match.tossMarketStatus = 'CLOSED';
                    match.tossBackA = null;
                    match.tossLayA = null;
                    match.tossBackB = null;
                    match.tossLayB = null;
                    match.tossDepthBackA = '0';
                    match.tossDepthLayA = '0';
                    match.tossDepthBackB = '0';
                    match.tossDepthLayB = '0';
                }

                // When match completes: close all markets and clear active odds
                if (newStatus === 'completed') {
                    match.marketStatus = 'CLOSED';
                    match.bookmakerMarketStatus = 'CLOSED';
                    match.tossMarketStatus = 'CLOSED';
                    match.backOddsA = null;
                    match.layOddsA = null;
                    match.backOddsB = null;
                    match.layOddsB = null;
                    match.bookmakerBackA = null;
                    match.bookmakerLayA = null;
                    match.bookmakerBackB = null;
                    match.bookmakerLayB = null;
                    match.tossBackA = null;
                    match.tossLayA = null;
                    match.tossBackB = null;
                    match.tossLayB = null;
                }

                await match.save();
                console.log(`[StatusService] Match ${match.matchId} status updated to ${newStatus}`);

                // Real-time Socket.IO synchronization
                if (io) {
                    io.emit('live_score_update', {
                        matchId: match.matchId,
                        status: newStatus,
                        statusText: newStatus === 'completed' ? 'Finished' : (match.score?.statusText || 'Live'),
                        winner: match.winner || null,
                        overs: match.score?.overs || (newStatus === 'completed' ? 'Final' : undefined)
                    });

                    const altId = String(match.matchId).startsWith('id') ? String(match.matchId).replace(/^id/, '') : ('id' + String(match.matchId));
                    io.emit('live_score_update', {
                        matchId: altId,
                        status: newStatus,
                        statusText: newStatus === 'completed' ? 'Finished' : (match.score?.statusText || 'Live'),
                        winner: match.winner || null,
                        overs: match.score?.overs || (newStatus === 'completed' ? 'Final' : undefined)
                    });

                    if (newStatus === 'live') {
                        io.emit('toss_odds_update', {
                            matchId: String(match.matchId),
                            tossMarketStatus: 'CLOSED',
                            tossWinner: match.tossWinner || null,
                            tossBackA: null,
                            tossLayA: null,
                            tossBackB: null,
                            tossLayB: null,
                            isLive: true,
                            updatedAt: now
                        });
                    }

                    if (newStatus === 'completed') {
                        // Settle bets and refund unmatched open bets immediately
                        settleMatch(match.matchId, match.winner || 'VOID', io).catch(err => {
                            console.error('[StatusService] Settlement trigger error:', err.message);
                        });

                        io.emit('match_updated', match);
                        io.emit('match_settled', {
                            matchId: match.matchId,
                            winner: match.winner,
                            score: match.score
                        });
                    }
                }
            }
        }

        // If any status updated, broadcast fresh matches list to immediately refresh UI
        if (matchChanged && io) {
            const allMatches = await Match.find().sort({ startTime: 1 });
            io.emit('matches_updated', allMatches);
        }
    } catch (error) {
        console.error('Error updating match statuses:', error.message);
    }
};

module.exports = { updateMatchStatuses, evaluateMatchCompletion, getMatchFormatInfo };
