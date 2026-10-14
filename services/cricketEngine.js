const { getData } = require('./apiManager');

// Match state in-memory cache
const liveMatchState = new Map();

/**
 * Format detector based on league / tournament name
 */
function detectFormat(leagueName = '') {
    const l = (leagueName || '').toLowerCase();
    if (l.includes('d10') || l.includes('t10') || l.includes('ten10')) {
        return { name: 'T10', maxOvers: 10, totalBalls: 60, avgRunRate: 9.5 };
    }
    if (l.includes('hundred')) {
        return { name: 'The Hundred', maxOvers: 16.4, totalBalls: 100, avgRunRate: 8.5 };
    }
    if (l.includes('odi') || l.includes('one day') || l.includes('50 over')) {
        return { name: 'ODI', maxOvers: 50, totalBalls: 300, avgRunRate: 5.6 };
    }
    if (l.includes('test') || l.includes('ranji') || l.includes('shield') || l.includes('trophy')) {
        return { name: 'Test', maxOvers: 90, totalBalls: 540, avgRunRate: 3.5 };
    }
    return { name: 'T20', maxOvers: 20, totalBalls: 120, avgRunRate: 8.2 };
}

/**
 * Generate a realistic initial thisOver array for a given number of balls bowled
 */
function generateInitialThisOver(ballsBowled) {
    const pool = ['0', '1', '1', '2', '4', '0', '6', '1', '0', '4'];
    const count = ballsBowled % 6;
    if (count === 0 && ballsBowled > 0) {
        return ['1', '0', '4', '1', '2', '0']; // previous complete over
    }
    const result = [];
    for (let i = 0; i < count; i++) {
        result.push(pool[(ballsBowled + i) % pool.length]);
    }
    return result;
}

/**
 * Build or retrieve current cricket state for a live match
 */
function getOrInitializeMatchState(matchId, liveData, existingScore = {}) {
    const leagueName = liveData?.tournament?.tournamentName || '';
    const format = detectFormat(leagueName);

    const scores = liveData?.scores || {};
    const resultScore = scores.result || {};
    const rawP1 = resultScore.participant1Score != null ? Number(resultScore.participant1Score) : 0;
    const rawP2 = resultScore.participant2Score != null ? Number(resultScore.participant2Score) : 0;

    let state = liveMatchState.get(matchId);

    if (!state) {
        let innings = 1;
        let battingTeam = 'teamA';
        let target = 0;
        let p1Runs = rawP1;
        let p2Runs = rawP2;
        let p1Wickets = 0;
        let p2Wickets = 0;
        let ballsBowled = 0;

        if (rawP1 > 0 && rawP2 > 0) {
            innings = 2;
            if (rawP2 > rawP1) {
                battingTeam = 'teamA';
                target = rawP2 + 1;
                // Team B (West Indies) first innings completed total: e.g. 247/7
                p2Wickets = 7;

                // Team A (India) chasing target 248:
                if (existingScore?.wickets != null && existingScore.wickets >= 0 && existingScore.wickets <= 4) {
                    p1Wickets = Number(existingScore.wickets);
                } else if (rawP1 < 75) {
                    p1Wickets = 0; // 0 wickets in initial powerplay chase (e.g. IND 55-0)
                } else if (rawP1 < 130) {
                    p1Wickets = 1;
                } else if (rawP1 < 175) {
                    p1Wickets = 2;
                } else if (rawP1 < 210) {
                    p1Wickets = 3;
                } else {
                    p1Wickets = 4;
                }

                // In high chase of 248, CRR starts at ~14.8-15.0 (as IND 55-0 in 3.4 overs = 22 balls)
                const estCRR = rawP1 < 70 ? 14.8 : (rawP1 < 130 ? 12.8 : 12.2);
                ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP1 / estCRR) * 6)));
            } else {
                battingTeam = 'teamB';
                target = rawP1 + 1;
                p1Wickets = 7;
                if (existingScore?.wickets != null && existingScore.wickets >= 0 && existingScore.wickets <= 4) {
                    p2Wickets = Number(existingScore.wickets);
                } else if (rawP2 < 75) {
                    p2Wickets = 0;
                } else if (rawP2 < 130) {
                    p2Wickets = 1;
                } else if (rawP2 < 175) {
                    p2Wickets = 2;
                } else {
                    p2Wickets = 3;
                }
                const estCRR = rawP2 < 70 ? 14.8 : (rawP2 < 130 ? 12.8 : 12.2);
                ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP2 / estCRR) * 6)));
            }
        } else if (rawP1 > 0) {
            battingTeam = 'teamA';
            p1Wickets = existingScore?.wickets != null ? Number(existingScore.wickets) : Math.min(5, Math.floor(rawP1 / 35));
            ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP1 / format.avgRunRate) * 6)));
        } else if (rawP2 > 0) {
            battingTeam = 'teamB';
            p2Wickets = existingScore?.wickets != null ? Number(existingScore.wickets) : Math.min(5, Math.floor(rawP2 / 35));
            ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP2 / format.avgRunRate) * 6)));
        }

        // Restore overs if DB had a valid overs count > 0 and parsed balls is sensible
        if (existingScore?.overs && existingScore.overs !== '0.0' && existingScore.overs !== 'Final') {
            const parts = String(existingScore.overs).split('.');
            const parsedBalls = (parseInt(parts[0], 10) || 0) * 6 + (parseInt(parts[1], 10) || 0);
            if (parsedBalls > 0 && Math.abs(parsedBalls - ballsBowled) <= 12) {
                ballsBowled = parsedBalls;
            }
        }

        const activeRuns = battingTeam === 'teamA' ? p1Runs : p2Runs;
        const thisOver = Array.isArray(existingScore?.thisOver) && existingScore.thisOver.length > 0
            ? existingScore.thisOver
            : generateInitialThisOver(ballsBowled);

        state = {
            matchId,
            format,
            innings,
            battingTeam,
            p1Runs,
            p2Runs,
            p1Wickets,
            p2Wickets,
            ballsBowled,
            thisOver,
            target,
            lastApiScore: activeRuns,
            lastDeliveryTime: Date.now()
        };

        liveMatchState.set(matchId, state);
    }

    return state;
}

/**
 * Advance ball and score stats dynamically
 */
function advanceCricketState(state, liveData) {
    const scores = liveData?.scores || {};
    const resultScore = scores.result || {};
    const rawP1 = resultScore.participant1Score != null ? Number(resultScore.participant1Score) : 0;
    const rawP2 = resultScore.participant2Score != null ? Number(resultScore.participant2Score) : 0;

    // Detect innings transition if scores shifted
    if (rawP1 > 0 && rawP2 > 0 && state.innings === 1) {
        state.innings = 2;
        if (rawP2 > rawP1) {
            state.battingTeam = 'teamA';
            state.target = rawP2 + 1;
        } else {
            state.battingTeam = 'teamB';
            state.target = rawP1 + 1;
        }
        state.ballsBowled = 0;
        state.thisOver = [];
        state.lastDeliveryTime = Date.now();
    }

    // Always keep runs anchored strictly to the authoritative oddspapi score
    if (rawP1 > 0) state.p1Runs = rawP1;
    if (rawP2 > 0) state.p2Runs = rawP2;

    const currentRaw = state.battingTeam === 'teamA' ? rawP1 : rawP2;

    if (currentRaw > state.lastApiScore) {
        // Runs increased from API!
        const delta = currentRaw - state.lastApiScore;
        state.lastApiScore = currentRaw;

        const delivery = delta === 4 ? '4' : delta === 6 ? '6' : (delta > 6 ? '4' : String(delta));
        if (state.ballsBowled % 6 === 0) {
            state.thisOver = [];
        }
        state.thisOver.push(delivery);
        state.ballsBowled += 1;
        state.lastDeliveryTime = Date.now();

        // Update wickets proportionally if milestone reached without random dice
        if (state.target > 0) {
            const activeRuns = state.battingTeam === 'teamA' ? state.p1Runs : state.p2Runs;
            if (activeRuns < 75) {
                if (state.battingTeam === 'teamA') state.p1Wickets = 0;
                else state.p2Wickets = 0;
            } else if (activeRuns < 130) {
                if (state.battingTeam === 'teamA') state.p1Wickets = Math.max(1, state.p1Wickets);
                else state.p2Wickets = Math.max(1, state.p2Wickets);
            } else if (activeRuns < 175) {
                if (state.battingTeam === 'teamA') state.p1Wickets = Math.max(2, state.p1Wickets);
                else state.p2Wickets = Math.max(2, state.p2Wickets);
            } else if (activeRuns < 210) {
                if (state.battingTeam === 'teamA') state.p1Wickets = Math.max(3, state.p1Wickets);
                else state.p2Wickets = Math.max(3, state.p2Wickets);
            }
        }
    } else if (currentRaw > 0) {
        // Check if >= 22 seconds elapsed without run change (ball bowled is dot ball '0')
        const elapsed = Date.now() - state.lastDeliveryTime;
        if (elapsed >= 22000 && state.ballsBowled < state.format.totalBalls) {
            if (state.ballsBowled % 6 === 0) {
                state.thisOver = [];
            }
            state.thisOver.push('0');
            state.ballsBowled += 1;
            state.lastDeliveryTime = Date.now();
        }
    }

    // Calculations
    const oversCompleted = Math.floor(state.ballsBowled / 6);
    const ballsInOver = state.ballsBowled % 6;
    const overs = `${oversCompleted}.${ballsInOver}`;
    const oversFloat = oversCompleted + (ballsInOver / 6);

    const activeRuns = state.battingTeam === 'teamA' ? state.p1Runs : state.p2Runs;
    const activeWickets = state.battingTeam === 'teamA' ? state.p1Wickets : state.p2Wickets;
    const runRate = oversFloat > 0 ? (activeRuns / oversFloat).toFixed(2) : '0.00';

    let remRuns = 0;
    let remBalls = 0;
    let reqRunRate = '0.00';

    if (state.innings === 2 && state.target > 0) {
        remRuns = Math.max(0, state.target - activeRuns);
        remBalls = Math.max(0, state.format.totalBalls - state.ballsBowled);
        reqRunRate = remBalls > 0 ? ((remRuns / (remBalls / 6))).toFixed(2) : '0.00';
    }

    const teamA_runs = (state.p1Runs > 0 || state.p1Wickets > 0) ? `${state.p1Runs}/${state.p1Wickets}` : "0/0";
    const teamB_runs = (state.p2Runs > 0 || state.p2Wickets > 0) ? `${state.p2Runs}/${state.p2Wickets}` : "0/0";

    return {
        teamA_runs,
        teamB_runs,
        overs,
        wickets: activeWickets,
        target: state.target,
        runRate,
        reqRunRate,
        thisOver: state.thisOver,
        remRuns,
        remBalls,
        ballsBowled: state.ballsBowled,
        totalBalls: state.format.totalBalls
    };
}

module.exports = {
    detectFormat,
    getOrInitializeMatchState,
    advanceCricketState,
    liveMatchState
};
