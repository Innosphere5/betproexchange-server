const Match = require('../models/Match');
const roanuzClient = require('./roanuzClient');
const redisCache = require('./upstashRedisCache');

/**
 * Normalizes team names for fuzzy matching between odds providers and Roanuz.
 */
const normalizeTeamName = (name) => {
  if (!name) return '';
  let n = name.toLowerCase().trim();
  n = n.replace(/\bwomen\b/g, '');
  n = n.replace(/\bw\b/g, '');  // strips trailing "W" gender suffix
  n = n.replace(/\bteam\b/g, '');
  n = n.replace(/\bcricket\b/g, '');
  n = n.replace(/\bnational\b/g, '');
  n = n.replace(/\bmen\b/g, '');
  n = n.replace(/\bxi\b/g, '');
  n = n.replace(/[^a-z0-9]/g, '');

  const aliases = {
    australia: 'aus',
    england: 'eng',
    southafrica: 'sa',
    bangladesh: 'ban',
    pakistan: 'pak',
    srilanka: 'sl',
    india: 'ind',
    newzealand: 'nz',
    westindies: 'wi',
    afghanistan: 'afg',
    zimbabwe: 'zim',
    ireland: 'ire',
    netherlands: 'ned',
    scotland: 'sco',
    royalchallengers: 'rcb', bengaluru: 'rcb', bangalore: 'rcb',
    lucknow: 'lsg', sunrisers: 'srh', hyderabad: 'srh',
    mumbaiindians: 'mi', mumbai: 'mi', chennaisuperkings: 'csk',
    chennai: 'csk', delhicapitals: 'dc', delhi: 'dc',
    rajasthanroyals: 'rr', rajasthan: 'rr', gujarattitans: 'gt',
    gujarat: 'gt', kolkataknightriders: 'kkr', kolkata: 'kkr',
    punjabkings: 'pbks', kingsxi: 'pbks', punjab: 'pbks',
    perthscorchers: 'perthscorchers',
    sydneythunder: 'sydneythunder',
    sydneysixers: 'sydneysixers',
    melbournereneg: 'melbournerenegades',
    melbournerenegades: 'melbournerenegades',
    melbournestars: 'melbournestars',
    brisbaneheat: 'brisbaneheat',
    hobarthurricanes: 'hobarthurricanes',
    adelaidestrikers: 'adelaidestrikers'
  };

  for (const [key, value] of Object.entries(aliases)) {
    if (n.includes(key)) return value;
  }
  return n;
};

/**
 * Format a Roanuz ball object or representation into standard cricket notation badge
 */
function formatRoanuzBallBadge(ball) {
  if (!ball) return '0';
  if (ball.repr) {
    if (ball.repr === 'r0') return '0';
    if (ball.repr === 'r1') return '1';
    if (ball.repr === 'r2') return '2';
    if (ball.repr === 'r3') return '3';
    if (ball.repr === 'r4') return '4';
    if (ball.repr === 'r5') return '5';
    if (ball.repr === 'r6') return '6';
    if (ball.repr.includes('wd')) return ball.team_score?.runs > 1 ? `${ball.team_score.runs}Wd` : 'Wd';
    if (ball.repr.includes('nb')) return ball.team_score?.runs > 1 ? `${ball.team_score.runs}Nb` : 'Nb';
    if (ball.repr.includes('lb')) return 'Lb';
    if (ball.repr.includes('b')) return 'B';
    if (ball.repr.startsWith('w') || ball.repr === 'w') return 'W';
  }
  if (ball.wicket || ball.is_wicket) return 'W';
  const runs = ball.team_score?.runs ?? ball.batsman?.runs ?? 0;
  return String(runs);
}

/**
 * Format string ball repr into standard cricket badge
 */
function formatReprBadge(reprStr) {
  if (!reprStr) return '0';
  const str = String(reprStr).toLowerCase();
  if (str === 'r0') return '0';
  if (str === 'r1') return '1';
  if (str === 'r2') return '2';
  if (str === 'r3') return '3';
  if (str === 'r4') return '4';
  if (str === 'r5') return '5';
  if (str === 'r6') return '6';
  if (str.includes('wd')) return 'Wd';
  if (str.includes('nb')) return 'Nb';
  if (str.includes('lb')) return 'Lb';
  if (str.includes('b')) return 'B';
  if (str.startsWith('w') || str === 'w') return 'W';
  return str.replace('r', '');
}

/**
 * Comprehensive parser for Roanuz Cricket API v5 match
 */
function parseRoanuzMatch(matchData, ballByBallData = null, matchInDb = null) {
  if (!matchData) return null;

  const rawTeamA = matchData.teams?.a?.name || 'Team 1';
  const rawTeamB = matchData.teams?.b?.name || 'Team 2';

  // Determine correct alignment of teamA / teamB against matchInDb if provided
  let teamAName = rawTeamA;
  let teamBName = rawTeamB;
  let teamAKey = 'a';
  let teamBKey = 'b';

  if (matchInDb && matchInDb.teamA && matchInDb.teamB) {
    const normCandA = normalizeTeamName(matchInDb.teamA);
    const normCandB = normalizeTeamName(matchInDb.teamB);
    const normA = normalizeTeamName(rawTeamA);
    const normB = normalizeTeamName(rawTeamB);

    if ((normCandA === normB || normCandB === normA) && normCandA !== normA) {
      teamAName = rawTeamB;
      teamBName = rawTeamA;
      teamAKey = 'b';
      teamBKey = 'a';
    }
  }

  const play = matchData.play || {};
  const live = play.live || {};
  const innings = play.innings || {};

  // Extract innings scores
  const innA1 = innings[`${teamAKey}_1`];
  const innA2 = innings[`${teamAKey}_2`];
  const innB1 = innings[`${teamBKey}_1`];
  const innB2 = innings[`${teamBKey}_2`];

  const scoreA1 = innA1?.score?.runs ?? 0;
  const wktA1 = innA1?.wickets ?? 0;
  const scoreB1 = innB1?.score?.runs ?? 0;
  const wktB1 = innB1?.wickets ?? 0;

  const scoreA2 = innA2?.score?.runs;
  const wktA2 = innA2?.wickets;
  const scoreB2 = innB2?.score?.runs;
  const wktB2 = innB2?.wickets;

  // Runs display string
  const teamA_runs = scoreA2 !== undefined
    ? `${scoreA1} & ${scoreA2}/${wktA2 ?? 0}`
    : `${scoreA1}/${wktA1}`;

  const teamB_runs = scoreB2 !== undefined
    ? `${scoreB1} & ${scoreB2}/${wktB2 ?? 0}`
    : `${scoreB1}/${wktB1}`;

  const teamA_wickets = scoreA2 !== undefined ? (wktA2 ?? 0) : wktA1;
  const teamB_wickets = scoreB2 !== undefined ? (wktB2 ?? 0) : wktB1;

  // Active batting and bowling teams
  const liveBattingKey = live.batting_team || (innB1 ? 'b' : 'a');
  const isTeamABatting = liveBattingKey === teamAKey;
  const battingTeam = isTeamABatting ? 'teamA' : 'teamB';
  const battingTeamName = isTeamABatting ? teamAName : teamBName;
  const bowlingTeamName = isTeamABatting ? teamBName : teamAName;

  const currentWickets = live.score?.wickets ?? (isTeamABatting ? teamA_wickets : teamB_wickets);
  const currentScore = live.score?.runs ?? (isTeamABatting ? scoreA1 : scoreB1);

  // Overs
  let currentOvers = 0.0;
  if (Array.isArray(live.score?.overs)) {
    currentOvers = Number(`${live.score.overs[0]}.${live.score.overs[1]}`);
  } else if (live.score?.overs !== undefined) {
    currentOvers = Number(live.score.overs);
  }

  // Target and required run rate
  let target = play.target?.runs || 0;
  let reqRunRate = "0.00";
  let remRuns = 0;
  let remBalls = 0;

  const maxOvers = play.overs_per_innings || (
    matchData.format === 't20' ? 20 :
    matchData.format === 'oneday' ? 50 :
    matchData.format === 't10' ? 10 : 20
  );
  const totalBallsMax = maxOvers * 6;

  if (target > 0) {
    remRuns = Math.max(0, target - currentScore);
    const innBalls = live.score?.balls ?? (Math.floor(currentOvers) * 6 + Math.round((currentOvers % 1) * 10));
    remBalls = Math.max(0, totalBallsMax - innBalls);
    if (remBalls > 0 && remRuns > 0) {
      reqRunRate = ((remRuns / remBalls) * 6).toFixed(2);
    }
  }

  // Run Rate
  const runRate = live.score?.run_rate ? Number(live.score.run_rate).toFixed(2) : "0.00";

  // Ball-by-ball thisOver calculation
  let thisOver = [];
  let lastBallText = '';

  if (ballByBallData && ballByBallData.data?.over?.balls?.length > 0) {
    const balls = ballByBallData.data.over.balls;
    thisOver = balls.map(formatRoanuzBallBadge);
    const lastBallObj = balls[balls.length - 1];
    if (lastBallObj) {
      const ovStr = Array.isArray(lastBallObj.overs) ? `${lastBallObj.overs[0]}.${lastBallObj.overs[1]}` : '';
      lastBallText = `${ovStr ? ovStr + ': ' : ''}${lastBallObj.comment || ''}`;
    }
  } else if (live.recent_overs_repr && live.recent_overs_repr.length > 0) {
    const latestOverRepr = live.recent_overs_repr[live.recent_overs_repr.length - 1];
    if (latestOverRepr && Array.isArray(latestOverRepr.ball_repr)) {
      thisOver = latestOverRepr.ball_repr.map(formatReprBadge);
    }
  }

  // Active Batsmen
  const striker = live.recent_players?.striker;
  const nonStriker = live.recent_players?.non_striker;
  const batsmen = [];
  if (striker) {
    batsmen.push({
      id: striker.key,
      name: striker.name,
      runs: striker.stats?.runs ?? 0,
      balls: striker.stats?.balls ?? 0,
      fours: striker.stats?.fours ?? 0,
      sixes: striker.stats?.sixes ?? 0,
      strikeRate: striker.stats?.strike_rate ?? (striker.stats?.balls > 0 ? Number(((striker.stats.runs / striker.stats.balls) * 100).toFixed(1)) : 0)
    });
  }
  if (nonStriker) {
    batsmen.push({
      id: nonStriker.key,
      name: nonStriker.name,
      runs: nonStriker.stats?.runs ?? 0,
      balls: nonStriker.stats?.balls ?? 0,
      fours: nonStriker.stats?.fours ?? 0,
      sixes: nonStriker.stats?.sixes ?? 0,
      strikeRate: nonStriker.stats?.strike_rate ?? (nonStriker.stats?.balls > 0 ? Number(((nonStriker.stats.runs / nonStriker.stats.balls) * 100).toFixed(1)) : 0)
    });
  }

  // Active Bowler
  const bowlerObj = live.recent_players?.bowler;
  let bowler = null;
  if (bowlerObj) {
    bowler = {
      id: bowlerObj.key,
      name: bowlerObj.name,
      overs: Array.isArray(bowlerObj.stats?.overs) ? `${bowlerObj.stats.overs[0]}.${bowlerObj.stats.overs[1]}` : (bowlerObj.stats?.overs || 0),
      maidens: bowlerObj.stats?.maiden_overs ?? 0,
      runs: bowlerObj.stats?.runs ?? 0,
      wickets: bowlerObj.stats?.wickets ?? 0,
      economy: bowlerObj.stats?.economy ?? 0
    };
  }

  // Match status and completion
  const isFinished = matchData.status === 'completed' || matchData.play_status === 'completed';
  const status = isFinished ? 'completed' : 'live';
  const oversDisplay = isFinished ? 'Final' : String(currentOvers);

  let winner = null;
  if (isFinished) {
    const rawWinnerKey = matchData.winner || play.result?.winner;
    if (rawWinnerKey === teamAKey) winner = teamAName;
    else if (rawWinnerKey === teamBKey) winner = teamBName;
    else if (play.result?.result_type === 'draw') winner = 'DRAW';
    else if (play.result?.result_type === 'tie') winner = 'TIE';
    else if (play.result?.msg_winner) {
      if (play.result.msg_winner.toLowerCase().includes(teamAName.toLowerCase())) winner = teamAName;
      else if (play.result.msg_winner.toLowerCase().includes(teamBName.toLowerCase())) winner = teamBName;
    }
  }

  // Toss info
  const tossWinnerKey = matchData.toss?.winner;
  const tossWinner = tossWinnerKey === teamAKey ? teamAName : (tossWinnerKey === teamBKey ? teamBName : null);
  const tossDecision = matchData.toss?.elected || null;

  // Status text
  const statusText = isFinished
    ? (play.result?.msg_winner || 'Finished')
    : (matchData.play_status === 'in_play' ? 'Live' : (matchData.status || 'Live'));

  // Periods
  const periods = {
    "0": {
      participant1Score: scoreA1,
      participant2Score: scoreB1,
      updatedAt: new Date().toISOString()
    }
  };
  if (innA1) {
    periods["1"] = {
      participant1Score: scoreA1,
      participant2Score: 0,
      updatedAt: new Date().toISOString()
    };
  }
  if (innB1) {
    periods["2"] = {
      participant1Score: 0,
      participant2Score: scoreB1,
      updatedAt: new Date().toISOString()
    };
  }

  return {
    matchId: String(matchData.key),
    roanuzMatchKey: matchData.key,
    teamA: matchInDb ? matchInDb.teamA : teamAName,
    teamB: matchInDb ? matchInDb.teamB : teamBName,
    league: matchData.tournament?.name || 'Cricket',
    teamA_runs,
    teamB_runs,
    teamA_wickets,
    teamB_wickets,
    overs: oversDisplay,
    wickets: currentWickets,
    target,
    runRate,
    reqRunRate,
    thisOver,
    remRuns,
    remBalls,
    battingTeam,
    battingTeamName,
    bowlingTeamName,
    innings: (live.innings && live.innings.endsWith('2')) ? 2 : 1,
    statusText,
    status,
    winner,
    batsmen,
    bowler,
    lastBall: lastBallText,
    tossWinner,
    tossDecision,
    periods,
    lastUpdated: new Date()
  };
}

class RoanuzScoreService {
  constructor() {
    this.memoryCache = new Map(); // matchId -> parsedScore
    this.isSyncing = false;
    this.syncStartedAt = 0;
    this.timer = null;
    this.io = null;
    this.pollIntervalLive = 1500;  // 1.5 seconds during active live in-play matches
    this.pollIntervalIdle = 6000;  // 6 seconds when idle / waiting
    this.SYNC_TIMEOUT_MS = 15000;  // Safety timeout

    this.dbWritePending = new Map();  // matchId -> { payload, timer }
    this.DB_WRITE_DEBOUNCE_MS = 4000; // Debounce Mongo writes to 4s
  }

  /**
   * Schedule a debounced MongoDB write
   */
  _scheduledDbWrite(matchId, payload) {
    const existing = this.dbWritePending.get(matchId);
    if (existing) {
      existing.payload = { ...existing.payload, ...payload };
      return;
    }
    const timer = setTimeout(async () => {
      this.dbWritePending.delete(matchId);
      try {
        await Match.updateOne({ matchId }, { $set: payload });
      } catch (err) {
        console.error(`[Roanuz] DB write error for ${matchId}:`, err.message);
      }
    }, this.DB_WRITE_DEBOUNCE_MS);

    this.dbWritePending.set(matchId, { payload, timer });
  }

  /**
   * Find match in MongoDB by Roanuz key or fuzzy team matching
   */
  async findMatchInDb(roanuzMatch) {
    const key = roanuzMatch.key;
    // 1. Match directly by roanuzMatchKey or matchId
    let match = await Match.findOne({
      $or: [
        { roanuzMatchKey: key },
        { matchId: key }
      ]
    });
    if (match) return match;

    // 2. Fuzzy match by team names against live & upcoming matches
    const nameA = roanuzMatch.teams?.a?.name;
    const nameB = roanuzMatch.teams?.b?.name;
    if (!nameA || !nameB) return null;

    const normA = normalizeTeamName(nameA);
    const normB = normalizeTeamName(nameB);

    const candidates = await Match.find({
      status: { $in: ['live', 'upcoming'] }
    }).lean();

    for (const cand of candidates) {
      const candA = normalizeTeamName(cand.teamA);
      const candB = normalizeTeamName(cand.teamB);

      const matchDirect = candA === normA && candB === normB;
      const matchReversed = candA === normB && candB === normA;

      if (matchDirect || matchReversed) {
        // Link Roanuz key in DB
        await Match.updateOne({ matchId: cand.matchId }, { $set: { roanuzMatchKey: key } }).catch(() => {});
        cand.roanuzMatchKey = key;
        console.log(`[Roanuz] 🔗 Linked ${cand.teamA} v ${cand.teamB} (DB matchId: ${cand.matchId}) → Roanuz ${key}`);
        return cand;
      }
    }

    return null;
  }

  /**
   * Master sync function called by polling loop
   */
  async syncLiveScores(io = null) {
    if (io && !this.io) this.io = io;

    // Mutual exclusion with safety timeout
    if (this.isSyncing) {
      if (Date.now() - this.syncStartedAt > this.SYNC_TIMEOUT_MS) {
        console.warn('[Roanuz] Mutex held too long — releasing lock');
        this.isSyncing = false;
      } else {
        return;
      }
    }

    this.isSyncing = true;
    this.syncStartedAt = Date.now();

    try {
      // 1. Fetch month fixtures to identify active / started / live matches
      const fixturesData = await roanuzClient.getFixtures();
      const days = fixturesData?.data?.month?.days || [];

      const activeMatches = [];
      for (const d of days) {
        for (const m of (d.matches || [])) {
          if (m.status === 'started' || m.status === 'live' || m.play_status === 'in_play') {
            activeMatches.push(m);
          }
        }
      }

      for (const activeMatch of activeMatches) {
        try {
          // Fetch full match detail & ball-by-ball
          const [matchDetail, ballByBall] = await Promise.all([
            roanuzClient.getMatch(activeMatch.key),
            roanuzClient.getBallByBall(activeMatch.key).catch(() => null)
          ]);

          const matchData = matchDetail?.data;
          if (!matchData) continue;

          // Find or create in DB
          let matchInDb = await this.findMatchInDb(matchData);
          if (!matchInDb) {
            // Auto-create live match if not in DB so it's instantly bettable & visible
            const newMatchId = String(matchData.key);
            const teamA = matchData.teams?.a?.name || 'Team A';
            const teamB = matchData.teams?.b?.name || 'Team B';
            const league = matchData.tournament?.name || 'Cricket';

            try {
              matchInDb = await Match.create({
                matchId: newMatchId,
                roanuzMatchKey: matchData.key,
                teamA,
                teamB,
                league,
                status: 'live',
                startTime: new Date(matchData.start_at ? matchData.start_at * 1000 : Date.now()),
                score: {}
              });
              console.log(`[Roanuz] 🆕 Auto-created live match in DB: ${teamA} v ${teamB} (${newMatchId})`);
            } catch (createErr) {
              matchInDb = await Match.findOne({ matchId: newMatchId });
            }
          }

          const parsed = parseRoanuzMatch(matchData, ballByBall, matchInDb);
          if (!parsed) continue;

          const matchDbId = matchInDb ? matchInDb.matchId : String(matchData.key);

          // Update memory cache
          this.memoryCache.set(matchDbId, parsed);
          this.memoryCache.set(String(matchData.key), parsed);

          // Update Redis cache (12s TTL)
          await redisCache.setScore(matchDbId, parsed, 12).catch(() => {});

          // Debounced DB persistence
          this._scheduledDbWrite(matchDbId, {
            status: parsed.status,
            score: {
              teamA_runs: parsed.teamA_runs,
              teamB_runs: parsed.teamB_runs,
              teamA_wickets: parsed.teamA_wickets,
              teamB_wickets: parsed.teamB_wickets,
              overs: parsed.overs,
              wickets: parsed.wickets,
              target: parsed.target,
              runRate: parsed.runRate,
              reqRunRate: parsed.reqRunRate,
              thisOver: parsed.thisOver,
              remRuns: parsed.remRuns,
              remBalls: parsed.remBalls,
              battingTeam: parsed.battingTeam,
              battingTeamName: parsed.battingTeamName,
              bowlingTeamName: parsed.bowlingTeamName,
              innings: parsed.innings,
              statusText: parsed.statusText,
              batsmen: parsed.batsmen,
              bowler: parsed.bowler,
              lastBall: parsed.lastBall,
              periods: parsed.periods,
              lastUpdated: new Date()
            },
            winner: parsed.winner,
            tossWinner: parsed.tossWinner,
            lastUpdated: new Date()
          });

          // Emit real-time Socket.IO events to clients
          if (this.io) {
            const socketPayload = {
              matchId: matchDbId,
              teamA_runs: parsed.teamA_runs,
              teamB_runs: parsed.teamB_runs,
              teamA_wickets: parsed.teamA_wickets,
              teamB_wickets: parsed.teamB_wickets,
              overs: parsed.overs,
              wickets: parsed.wickets,
              target: parsed.target,
              runRate: parsed.runRate,
              reqRunRate: parsed.reqRunRate,
              thisOver: parsed.thisOver,
              remRuns: parsed.remRuns,
              remBalls: parsed.remBalls,
              battingTeam: parsed.battingTeam,
              battingTeamName: parsed.battingTeamName,
              bowlingTeamName: parsed.bowlingTeamName,
              innings: parsed.innings,
              statusText: parsed.statusText,
              batsmen: parsed.batsmen,
              bowler: parsed.bowler,
              lastBall: parsed.lastBall,
              tossWinner: parsed.tossWinner,
              tossDecision: parsed.tossDecision,
              periods: parsed.periods
            };

            this.io.emit('live_score_update', socketPayload);

            // Emit with alternate 'id' prefix so no frontend check fails
            const altId = String(matchDbId).startsWith('id')
              ? String(matchDbId).replace(/^id/, '')
              : ('id' + String(matchDbId));
            this.io.emit('live_score_update', { ...socketPayload, matchId: altId });

            // Emit for Roanuz key if different
            if (String(matchData.key) !== matchDbId && String(matchData.key) !== altId) {
              this.io.emit('live_score_update', { ...socketPayload, matchId: String(matchData.key) });
            }

            // Trigger fancy markets pricing and suspension engine
            try {
              const fancyMarketsService = require('./fancyMarketsService');
              fancyMarketsService.handleLiveMatchOdds(matchDbId, this.io);
            } catch (fErr) {}
          }
        } catch (mErr) {
          console.warn(`[Roanuz] Error syncing match ${activeMatch.key}:`, mErr.message);
        }
      }

      return activeMatches.length;
    } catch (err) {
      console.error('[Roanuz] ❌ Live sync error:', err.message);
      return 0;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Start master real-time live score engine loop
   */
  startLiveScoreEngine(io) {
    this.io = io;
    console.log('⚡ [Roanuz] Starting real-time Live Score Engine (sub-2s ball ticker)...');

    const runLoop = async () => {
      try {
        const liveCount = await this.syncLiveScores(this.io);
        const delay = liveCount > 0 ? this.pollIntervalLive : this.pollIntervalIdle;
        this.timer = setTimeout(runLoop, delay);
      } catch (e) {
        this.timer = setTimeout(runLoop, this.pollIntervalIdle);
      }
    };

    runLoop();
  }

  /**
   * Stop loop
   */
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get cached live score for a specific matchId
   */
  async getLiveScore(matchId) {
    if (!matchId) return null;

    // 1. In-process cache (0ms)
    if (this.memoryCache.has(matchId)) {
      return this.memoryCache.get(matchId);
    }

    // 2. Redis cache (sub-5ms)
    const cached = await redisCache.getScore(matchId).catch(() => null);
    if (cached) {
      this.memoryCache.set(matchId, cached);
      return cached;
    }

    // 3. Fallback to MongoDB
    const match = await Match.findOne({
      $or: [{ matchId }, { roanuzMatchKey: matchId }]
    }).lean();

    if (match && match.score) {
      const scoreObj = {
        matchId: match.matchId,
        teamA: match.teamA,
        teamB: match.teamB,
        league: match.league,
        status: match.status,
        ...match.score
      };
      this.memoryCache.set(matchId, scoreObj);
      return scoreObj;
    }

    return null;
  }
}

const serviceInstance = new RoanuzScoreService();

module.exports = {
  roanuzScoreService: serviceInstance,
  parseRoanuzMatch,
  formatRoanuzBallBadge
};
