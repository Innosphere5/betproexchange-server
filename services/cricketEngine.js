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
                p2Wickets = Math.min(9, Math.max(2, Math.floor(rawP2 / (format.name === 'T10' ? 25 : 30))));
                p1Wickets = Math.min(9, Math.max(1, Math.floor(rawP1 / (format.name === 'T10' ? 20 : 25))));
                ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP1 / format.avgRunRate) * 6)));
            } else {
                battingTeam = 'teamB';
                target = rawP1 + 1;
                p1Wickets = Math.min(9, Math.max(2, Math.floor(rawP1 / (format.name === 'T10' ? 25 : 30))));
                p2Wickets = Math.min(9, Math.max(1, Math.floor(rawP2 / (format.name === 'T10' ? 20 : 25))));
                ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP2 / format.avgRunRate) * 6)));
            }
        } else if (rawP1 > 0) {
            battingTeam = 'teamA';
            p1Wickets = Math.min(9, Math.max(0, Math.floor(rawP1 / (format.name === 'T10' ? 20 : 30))));
            ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP1 / format.avgRunRate) * 6)));
        } else if (rawP2 > 0) {
            battingTeam = 'teamB';
            p2Wickets = Math.min(9, Math.max(0, Math.floor(rawP2 / (format.name === 'T10' ? 20 : 30))));
            ballsBowled = Math.min(format.totalBalls - 1, Math.max(1, Math.round((rawP2 / format.avgRunRate) * 6)));
        }

        // Restore overs if DB had a valid overs count > 0
        if (existingScore?.overs && existingScore.overs !== '0.0' && existingScore.overs !== 'Final') {
            const parts = String(existingScore.overs).split('.');
            const parsedBalls = (parseInt(parts[0], 10) || 0) * 6 + (parseInt(parts[1], 10) || 0);
            if (parsedBalls > 0) {
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

    const currentRaw = state.battingTeam === 'teamA' ? rawP1 : rawP2;

    if (currentRaw > state.lastApiScore) {
        // Runs increased from API!
        const delta = currentRaw - state.lastApiScore;
        state.lastApiScore = currentRaw;

        if (state.battingTeam === 'teamA') {
            state.p1Runs = currentRaw;
        } else {
            state.p2Runs = currentRaw;
        }

        const delivery = delta === 4 ? '4' : delta === 6 ? '6' : String(delta);
        if (state.ballsBowled % 6 === 0) {
            state.thisOver = [];
        }
        state.thisOver.push(delivery);
        state.ballsBowled += 1;
        state.lastDeliveryTime = Date.now();
    } else if (currentRaw > 0) {
        // Check if >= 20 seconds elapsed to bowl next ball
        const elapsed = Date.now() - state.lastDeliveryTime;
        if (elapsed >= 20000 && state.ballsBowled < state.format.totalBalls) {
            const rand = Math.random();
            let ballOutcome = '0';
            let ballRuns = 0;

            if (rand < 0.40) {
                ballOutcome = '0';
            } else if (rand < 0.72) {
                ballOutcome = '1';
                ballRuns = 1;
            } else if (rand < 0.84) {
                ballOutcome = '2';
                ballRuns = 2;
            } else if (rand < 0.92) {
                ballOutcome = '4';
                ballRuns = 4;
            } else if (rand < 0.96) {
                ballOutcome = '6';
                ballRuns = 6;
            } else {
                ballOutcome = 'W';
                if (state.battingTeam === 'teamA') {
                    state.p1Wickets = Math.min(10, state.p1Wickets + 1);
                } else {
                    state.p2Wickets = Math.min(10, state.p2Wickets + 1);
                }
            }

            if (ballRuns > 0) {
                if (state.battingTeam === 'teamA') {
                    state.p1Runs += ballRuns;
                } else {
                    state.p2Runs += ballRuns;
                }
                state.lastApiScore += ballRuns;
            }

            if (state.ballsBowled % 6 === 0) {
                state.thisOver = [];
            }
            state.thisOver.push(ballOutcome);
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
