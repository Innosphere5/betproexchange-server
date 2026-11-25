const Match = require('../models/Match');
const sportmonksClient = require('./sportmonksClient');
const poolClient = require('./sportmonksPoolClient');
const redisCache = require('./upstashRedisCache');

/**
 * Normalizes team names for fuzzy matching between odds providers and Sportmonks.
 * Strips gender suffixes (W, Women) so "Perth Scorchers W" matches "Perth Scorchers".
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
    royalchallengers: 'rcb', bengaluru: 'rcb', bangalore: 'rcb',
    lucknow: 'lsg', sunrisers: 'srh', hyderabad: 'srh',
    mumbaiindians: 'mi', mumbai: 'mi', chennaisuperkings: 'csk',
    chennai: 'csk', delhicapitals: 'dc', delhi: 'dc',
    rajasthanroyals: 'rr', rajasthan: 'rr', gujarattitans: 'gt',
    gujarat: 'gt', kolkataknightriders: 'kkr', kolkata: 'kkr',
    punjabkings: 'pbks', kingsxi: 'pbks', punjab: 'pbks',
    // WBBL team aliases — Perth Scorchers W → perthscorchers
    perthscorchers: 'perthscorchers',
    sydneythunder: 'sydneythunder',
    sydneysixers: 'sydneysixers',
    melbournereneg: 'melbournerenegades',
    melbournerenegades: 'melbournerenegades',
    melbournestars: 'melbournestars',
    brisbanefire: 'brisbanefire',
    hobarthurricanes: 'hobarthurricanes',
    adelaidestrikers: 'adelaidestrikers'
  };

  for (const [key, value] of Object.entries(aliases)) {
    if (n.includes(key)) return value;
  }
  return n;
};

/**
 * Format a ball object into standard cricket notation
 */
function formatBallBadge(ball) {
  if (!ball || !ball.score) return '0';
  const sc = ball.score;
  if (sc.is_wicket || sc.out) return 'W';
  if (sc.six) return '6';
  if (sc.four) return '4';
  if (sc.noball || (sc.name && sc.name.toLowerCase().includes('no ball'))) {
    return sc.runs > 1 ? `${sc.runs}Nb` : 'Nb';
  }
  if (sc.noball_runs > 0) return `${sc.noball_runs}Nb`;
  if (sc.bye > 0) return `${sc.bye}B`;
  if (sc.leg_bye > 0) return `${sc.leg_bye}Lb`;
  if (sc.name && sc.name.toLowerCase().includes('wide')) {
    return sc.runs > 1 ? `${sc.runs}Wd` : 'Wd';
  }
  return String(sc.runs ?? 0);
}

/**
 * Comprehensive parser for Sportmonks Cricket v2.0 fixture
 */
/**
 * Comprehensive parser for Sportmonks Cricket v2.0 fixture
 */
function parseSportmonksFixture(fixture, matchInDb = null) {
  if (!fixture) return null;

  const localTeamId = fixture.localteam_id;
  const visitorTeamId = fixture.visitorteam_id;
  const localTeamName = fixture.localteam?.name || 'Team 1';
  const visitorTeamName = fixture.visitorteam?.name || 'Team 2';

  // Determine correct mapping of teamA / teamB against matchInDb if provided
  let teamA_id = localTeamId;
  let teamB_id = visitorTeamId;
  let teamAName = localTeamName;
  let teamBName = visitorTeamName;

  if (matchInDb && matchInDb.teamA && matchInDb.teamB) {
    const normCandA = normalizeTeamName(matchInDb.teamA);
    const normCandB = normalizeTeamName(matchInDb.teamB);
    const normLocal = normalizeTeamName(localTeamName);
    const normVisitor = normalizeTeamName(visitorTeamName);

    if ((normCandA === normVisitor || normCandB === normLocal) && normCandA !== normLocal) {
      teamA_id = visitorTeamId;
      teamB_id = localTeamId;
      teamAName = visitorTeamName;
      teamBName = localTeamName;
    }
  }

  const runsList = fixture.runs || [];
  // Separate runs by team ID
  const runsA = runsList.filter(r => r.team_id === teamA_id);
  const runsB = runsList.filter(r => r.team_id === teamB_id);

  const runsA_latest = runsA.length > 0 ? runsA[runsA.length - 1] : null;
  const runsB_latest = runsB.length > 0 ? runsB[runsB.length - 1] : null;

  const teamA_score = runsA_latest ? (runsA_latest.score ?? 0) : 0;
  const teamA_wickets = runsA_latest ? (runsA_latest.wickets ?? 0) : 0;
  const teamA_overs = runsA_latest ? Number(runsA_latest.overs ?? 0) : 0.0;

  const teamB_score = runsB_latest ? (runsB_latest.score ?? 0) : 0;
  const teamB_wickets = runsB_latest ? (runsB_latest.wickets ?? 0) : 0;
  const teamB_overs = runsB_latest ? Number(runsB_latest.overs ?? 0) : 0.0;

  const teamA_runs = runsA_latest ? `${teamA_score}/${teamA_wickets}` : '0/0';
  const teamB_runs = runsB_latest ? `${teamB_score}/${teamB_wickets}` : '0/0';

  // Determine current active batting team from active batsmen or inning state
  const battingList = fixture.batting || [];
  const activeBatsman = battingList.find(b => b.active === true);

  let currentInnings = 1;
  let battingTeam = 'teamA';
  let battingTeamName = teamAName;
  let bowlingTeamName = teamBName;
  let currentOvers = teamA_overs;
  let currentWickets = teamA_wickets;
  let currentScore = teamA_score;

  if (activeBatsman) {
    if (activeBatsman.team_id === teamB_id) {
      battingTeam = 'teamB';
      battingTeamName = teamBName;
      bowlingTeamName = teamAName;
      currentOvers = teamB_overs;
      currentWickets = teamB_wickets;
      currentScore = teamB_score;
      currentInnings = runsA_latest ? 2 : 1;
    } else {
      battingTeam = 'teamA';
      battingTeamName = teamAName;
      bowlingTeamName = teamBName;
      currentOvers = teamA_overs;
      currentWickets = teamA_wickets;
      currentScore = teamA_score;
      currentInnings = runsB_latest ? 2 : 1;
    }
  } else if (runsA_latest && runsB_latest) {
    // Both teams have run records; active is the one corresponding to the latest inning
    const lastRun = runsList[runsList.length - 1];
    if (lastRun && lastRun.team_id === teamB_id) {
      battingTeam = 'teamB';
      battingTeamName = teamBName;
      bowlingTeamName = teamAName;
      currentOvers = teamB_overs;
      currentWickets = teamB_wickets;
      currentScore = teamB_score;
    }
    currentInnings = 2;
  } else if (runsB_latest && !runsA_latest) {
    battingTeam = 'teamB';
    battingTeamName = teamBName;
    bowlingTeamName = teamAName;
    currentOvers = teamB_overs;
    currentWickets = teamB_wickets;
    currentScore = teamB_score;
  }

  // Target calculation
  let target = 0;
  if (fixture.rpc_target && Number(fixture.rpc_target) > 0) {
    target = Number(fixture.rpc_target);
  } else if (fixture.note && /target\s+(\d+)/i.test(fixture.note)) {
    target = parseInt(fixture.note.match(/target\s+(\d+)/i)[1], 10);
  } else if (currentInnings === 2 || fixture.status === 'Innings Break' || fixture.status === '2nd Innings') {
    const firstInnScore = battingTeam === 'teamB' ? teamA_score : teamB_score;
    if (firstInnScore > 0) {
      target = firstInnScore + 1;
    }
  }

  // Format determination (max overs)
  const totalOversMax = fixture.total_overs_played || (
    fixture.type === 'T20I' || fixture.type === 'T20' ? 20 :
    fixture.type === 'ODI' ? 50 :
    fixture.type === 'T10' ? 10 : 20
  );
  const totalBallsMax = totalOversMax * 6;

  // CRR
  const oversWhole = Math.floor(currentOvers);
  const oversBalls = Math.round((currentOvers % 1) * 10);
  const oversFraction = oversWhole + (oversBalls / 6);

  let runRate = "0.00";
  if (oversFraction > 0) {
    runRate = (currentScore / oversFraction).toFixed(2);
  }

  // RRR and remaining balls/runs
  let remRuns = 0;
  let remBalls = 0;
  let reqRunRate = "0.00";

  if (target > 0) {
    remRuns = Math.max(0, target - currentScore);
    const innBalls = Math.floor(currentOvers) * 6 + Math.round((currentOvers % 1) * 10);
    remBalls = Math.max(0, totalBallsMax - innBalls);
    if (remBalls > 0 && remRuns > 0) {
      reqRunRate = ((remRuns / remBalls) * 6).toFixed(2);
    }
  }

  // Ball-by-ball thisOver calculation
  const ballsList = fixture.balls || [];
  let thisOver = [];
  let lastBallText = '';

  if (ballsList.length > 0) {
    const currentScoreboard = currentInnings === 2 ? 'S2' : 'S1';
    const innBalls = ballsList.filter(b => !b.scoreboard || b.scoreboard === currentScoreboard);
    const activeBalls = innBalls.length > 0 ? innBalls : ballsList;

    const latestBallObj = activeBalls[activeBalls.length - 1];
    if (latestBallObj) {
      const latestBallNumber = latestBallObj.ball;
      const currentOverIndex = Math.floor(latestBallNumber);

      const ballsInOver = activeBalls.filter(b => Math.floor(b.ball) === currentOverIndex);
      thisOver = ballsInOver.map(formatBallBadge);

      const bowlerName = latestBallObj.bowler?.fullname || latestBallObj.bowler?.lastname || 'Bowler';
      const batsmanName = latestBallObj.batsman?.fullname || latestBallObj.batsman?.lastname || 'Batsman';
      const actionName = latestBallObj.score?.name || `${latestBallObj.score?.runs || 0} Runs`;
      lastBallText = `${latestBallObj.ball}: ${actionName} (${bowlerName} to ${batsmanName})`;
    }
  }

  // Active batsmen
  const batsmen = battingList.filter(b => b.active === true).map(b => ({
    id: b.player_id,
    name: b.batsman?.fullname || 'Batsman',
    runs: b.score ?? 0,
    balls: b.ball ?? 0,
    fours: b.four_x ?? 0,
    sixes: b.six_x ?? 0,
    strikeRate: b.rate ?? (b.ball > 0 ? Number(((b.score / b.ball) * 100).toFixed(1)) : 0)
  }));

  // Active bowler
  const bowlingList = fixture.bowling || [];
  let activeBowlerObj = bowlingList.find(b => b.active === true);
  if (!activeBowlerObj && bowlingList.length > 0) {
    activeBowlerObj = bowlingList[bowlingList.length - 1];
  }

  let bowler = null;
  if (activeBowlerObj) {
    bowler = {
      id: activeBowlerObj.player_id,
      name: activeBowlerObj.bowler?.fullname || 'Bowler',
      overs: activeBowlerObj.overs ?? 0,
      maidens: activeBowlerObj.medians ?? 0,
      runs: activeBowlerObj.runs ?? 0,
      wickets: activeBowlerObj.wickets ?? 0,
      economy: activeBowlerObj.rate ?? 0
    };
  }

  // Status mapping
  const fixtureStatusNorm = String(fixture.status || '').toLowerCase().trim();
  const isApiFinished = fixtureStatusNorm === 'finished' || 
                        fixtureStatusNorm === 'completed' ||
                        fixtureStatusNorm === 'ended' ||
                        fixtureStatusNorm === 'aband.' || 
                        fixtureStatusNorm === 'postp.' || 
                        fixtureStatusNorm === 'result' ||
                        fixtureStatusNorm === 'no result' ||
                        fixture.live === false;

  const isTargetChased = target > 0 && (
    (battingTeam === 'teamB' && teamB_score >= target) ||
    (battingTeam === 'teamA' && teamA_score >= target)
  );

  const isAllOutInChase = target > 0 && currentWickets >= 10;
  const isChaseBallsExhausted = target > 0 && remBalls === 0 && remRuns > 0;

  const isFinished = isApiFinished || isTargetChased || isAllOutInChase || isChaseBallsExhausted;

  const status = isFinished ? 'completed' : 'live';
  const oversDisplay = isFinished ? 'Final' : String(currentOvers);

  let winner = null;
  if (isFinished) {
    if (fixture.winner_team_id === teamA_id) winner = teamAName;
    else if (fixture.winner_team_id === teamB_id) winner = teamBName;
    else if (fixture.note && fixture.note.toLowerCase().includes('won')) {
      if (fixture.note.toLowerCase().includes(teamAName.toLowerCase())) winner = teamAName;
      else if (fixture.note.toLowerCase().includes(teamBName.toLowerCase())) winner = teamBName;
    }

    if (!winner) {
      if (isTargetChased) {
        winner = battingTeamName;
      } else if (teamA_score > teamB_score) {
        winner = teamAName;
      } else if (teamB_score > teamA_score) {
        winner = teamBName;
      } else if (teamA_score > 0 && teamA_score === teamB_score) {
        winner = 'TIE';
      } else {
        winner = 'VOID';
      }
    }
  }

  // Standard period breakdowns
  const periods = {
    "0": {
      participant1Score: teamA_score,
      participant2Score: teamB_score,
      updatedAt: new Date().toISOString()
    }
  };
  if (runsA_latest) {
    periods["1"] = {
      participant1Score: teamA_score,
      participant2Score: 0,
      updatedAt: runsA_latest.updated_at || new Date().toISOString()
    };
  }
  if (runsB_latest) {
    periods["2"] = {
      participant1Score: 0,
      participant2Score: teamB_score,
      updatedAt: runsB_latest.updated_at || new Date().toISOString()
    };
  }

  return {
    matchId: String(fixture.id),
    fixtureId: fixture.id,
    teamA: matchInDb ? matchInDb.teamA : teamAName,
    teamB: matchInDb ? matchInDb.teamB : teamBName,
    league: fixture.league?.name || 'Cricket',
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
    innings: currentInnings,
    statusText: fixture.status || (isFinished ? 'Finished' : 'Live'),
    status,
    winner,
    batsmen,
    bowler,
    lastBall: lastBallText,
    tossWinner: fixture.tosswon?.name || null,
    tossDecision: fixture.elected || null,
    periods,
    lastUpdated: new Date()
  };
}

class SportmonksScoreService {
  constructor() {
    this.memoryCache = new Map(); // matchId -> parsedScore (in-process, sub-ms)
    this.isSyncing = false;
    this.syncStartedAt = 0;       // Timestamp when sync started — for deadlock detection
    this.timer = null;
    this.io = null;
    this.pollIntervalLive = 1500;    // 1.5 seconds during active live in-play matches (ultra-fast sub-2s)
    this.pollIntervalIdle = 6000;    // 6 seconds when idle / waiting
    this.SYNC_TIMEOUT_MS = 15000;    // Safety: auto-release mutex after 15s to prevent deadlock

    // DB write debounce — batch MongoDB writes to reduce Atlas latency on the hot path.
    // Scores are served instantly from Redis/memory; DB is updated every 5s max per match.
    this.dbWritePending = new Map();  // matchId -> { payload, timer }
    this.DB_WRITE_DEBOUNCE_MS = 5000; // Debounce DB writes to every 5s max per match
  }

  /**
   * Schedule a debounced MongoDB write.
   * Collapses rapid consecutive writes into one write per 5s per match.
   */
  _scheduledDbWrite(matchId, payload) {
    const existing = this.dbWritePending.get(matchId);
    if (existing) {
      // Update the payload but don't reset the timer — let the existing timer fire
      existing.payload = { ...existing.payload, ...payload };
      return;
    }
    const timer = setTimeout(async () => {
      this.dbWritePending.delete(matchId);
      try {
        await Match.updateOne({ matchId }, { $set: payload });
      } catch (err) {
        console.error(`[Sportmonks] DB write error for ${matchId}:`, err.message);
      }
    }, this.DB_WRITE_DEBOUNCE_MS);
    this.dbWritePending.set(matchId, { payload, timer });
  }

  /**
   * Force-flush a pending DB write immediately (used on match completion).
   */
  async _flushDbWrite(matchId, payload) {
    const existing = this.dbWritePending.get(matchId);
    if (existing) {
      clearTimeout(existing.timer);
      this.dbWritePending.delete(matchId);
    }
    await Match.updateOne({ matchId }, { $set: payload });
  }

  /**
   * Find matching database fixture for a Sportmonks fixture.
   * Uses multi-stage matching: ID → sportmonksFixtureId → team name fuzzy match.
   * Enhanced: also checks recently-completed matches so WBBL results settle correctly.
   */
  async findMatchInDb(fixture) {
    const fixtureIdNum = fixture.id;
    const fixtureIdStr = String(fixture.id);

    // 1. Direct match on sportmonksFixtureId, matchId, or oddsApiEventId
    let match = await Match.findOne({
      $or: [
        { sportmonksFixtureId: fixtureIdNum },
        { matchId: fixtureIdStr },
        { matchId: 'id' + fixtureIdStr },
        { oddsApiEventId: fixtureIdStr },
        { oddsApiEventId: 'id' + fixtureIdStr }
      ]
    });
    if (match) return match;

    // 2. Team name fuzzy matching — covers live, upcoming, AND recently completed (last 3h)
    const normHome = normalizeTeamName(fixture.localteam?.name);
    const normAway = normalizeTeamName(fixture.visitorteam?.name);

    if (normHome && normAway) {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const candidates = await Match.find({
        $or: [
          { status: { $in: ['live', 'upcoming'] } },
          { status: 'completed', lastUpdated: { $gte: threeHoursAgo } }
        ]
      });

      for (const cand of candidates) {
        const candA = normalizeTeamName(cand.teamA);
        const candB = normalizeTeamName(cand.teamB);

        // Exact normalized match OR substring match (handles "Perth Scorchers" ↔ "Perth Scorchers W")
        const homeMatchesA = candA === normHome || candA.includes(normHome) || normHome.includes(candA);
        const awayMatchesB = candB === normAway || candB.includes(normAway) || normAway.includes(candB);
        const homeMatchesB = candB === normHome || candB.includes(normHome) || normHome.includes(candB);
        const awayMatchesA = candA === normAway || candA.includes(normAway) || normAway.includes(candA);

        const matchFound = (homeMatchesA && awayMatchesB) || (homeMatchesB && awayMatchesA);

        if (matchFound) {
          if (!cand.sportmonksFixtureId) {
            await Match.updateOne({ matchId: cand.matchId }, { $set: { sportmonksFixtureId: fixtureIdNum } });
            cand.sportmonksFixtureId = fixtureIdNum;
            console.log(`[Sportmonks] 🔗 Linked ${cand.teamA} v ${cand.teamB} (DB matchId: ${cand.matchId}) → Sportmonks ${fixtureIdNum}`);
          }
          return cand;
        }
      }
    }

    return null;
  }

  /**
   * Fetch and sync all live scores from Sportmonks
   *
   * Upgrade: Uses pool client for multi-key rotation and Upstash Redis for
   * sub-ms score cache reads. MongoDB writes are debounced to 5s intervals
   * on the hot path — scores broadcast via Socket.IO immediately from memory.
   */
  async syncLiveScores(io = null) {
    // Deadlock-safe mutex: auto-release if previous sync has been stuck for >15s
    if (this.isSyncing) {
      const lockAge = Date.now() - this.syncStartedAt;
      if (lockAge < this.SYNC_TIMEOUT_MS) {
        return 0; // Normal concurrent call — skip
      }
      console.warn(`[SportmonksScoreService] ⚠️ Mutex deadlock detected! Lock held for ${lockAge}ms. Force-releasing...`);
      this.isSyncing = false;
    }
    this.isSyncing = true;
    this.syncStartedAt = Date.now();
    if (io) this.io = io;

    try {
      let liveFixtures = [];
      const liveIds = new Set(); // dedup by fixture ID

      const addFixtures = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const f of arr) {
          if (f && f.id && !liveIds.has(f.id)) {
            liveIds.add(f.id);
            liveFixtures.push(f);
          }
        }
      };

      try {
        // ── Primary: Check Redis cache (500ms TTL) ──────────────────────────
        const cached = await redisCache.get('bpx:livescores:all');
        if (cached && Array.isArray(cached)) {
          addFixtures(cached);
        } else {
          // ── Fetch both /livescores and /livescores/inplay in parallel ───────
          // /livescores sometimes omits women's leagues on trial plans.
          // /livescores/inplay may return a broader set.
          const [mainRes, inplayRes] = await Promise.allSettled([
            poolClient.getLiveScores(),
            poolClient.getInplayFixtures()
          ]);

          if (mainRes.status === 'fulfilled') addFixtures(mainRes.value);
          if (inplayRes.status === 'fulfilled') addFixtures(inplayRes.value);

          if (liveFixtures.length > 0) {
            await redisCache.set('bpx:livescores:all', liveFixtures, 500);
          }
        }
      } catch (err) {
        console.warn('[SportmonksScoreService] ⚠️ Live scores fetch failed:', err.message);
      }

      // ── Targeted recovery + proactive WBBL link-and-fetch ──────────────────
      // For every DB match marked 'live':
      //   a) If it already has a sportmonksFixtureId → fetch it directly (may not be in /livescores)
      //   b) If NO sportmonksFixtureId → try to find it in Sportmonks via today's date search,
      //      then link it. This is how WBBL matches get linked on first encounter.
      const liveDbMatches = await Match.find({ status: 'live' });

      // Today's date in YYYY-MM-DD (Sportmonks uses UTC)
      const todayStr = new Date().toISOString().slice(0, 10);

      // Cache today's fixture list (fetched once per sync cycle, 10s TTL)
      let todayFixtures = null;
      const getTodayFixtures = async () => {
        if (todayFixtures !== null) return todayFixtures;
        try {
          const cacheKey = `bpx:sportmonks:today:${todayStr}`;
          const cached = await redisCache.get(cacheKey);
          if (cached) { todayFixtures = cached; return todayFixtures; }
          const res = await poolClient.getFixturesByDate(todayStr);
          todayFixtures = Array.isArray(res) ? res : [];
          if (todayFixtures.length > 0) {
            await redisCache.set(cacheKey, todayFixtures, 10000); // 10s cache
            console.log(`[Sportmonks] 📅 Today's fixtures: ${todayFixtures.length} found`);
          }
        } catch (e) {
          todayFixtures = [];
        }
        return todayFixtures;
      };

      for (const dbM of liveDbMatches) {
        let fId = dbM.sportmonksFixtureId;

        // ── Case A: No Sportmonks ID → try to discover via date-based search ──
        if (!fId) {
          try {
            const todayList = await getTodayFixtures();
            const normA = normalizeTeamName(dbM.teamA);
            const normB = normalizeTeamName(dbM.teamB);

            for (const f of todayList) {
              if (!f || !f.id) continue;
              const fNormHome = normalizeTeamName(f.localteam?.name || '');
              const fNormAway = normalizeTeamName(f.visitorteam?.name || '');
              const matched = (fNormHome === normA && fNormAway === normB) ||
                              (fNormHome === normB && fNormAway === normA) ||
                              (normA && fNormHome.includes(normA) && normB && fNormAway.includes(normB)) ||
                              (normA && fNormAway.includes(normA) && normB && fNormHome.includes(normB));
              if (matched) {
                fId = f.id;
                // Persist the link so future polls use Case B (direct fetch)
                await Match.updateOne(
                  { matchId: dbM.matchId },
                  { $set: { sportmonksFixtureId: fId } }
                );
                console.log(`[Sportmonks] 🔗 Auto-linked ${dbM.teamA} v ${dbM.teamB} → Sportmonks fixture ${fId}`);
                // Add to live fixtures if detailed data present (runs, balls)
                if (f.runs) addFixtures([f]);
                break;
              }
            }
          } catch (e) {
            // silent — discovery is best-effort
          }
        }

        // ── Case B: Has Sportmonks ID but not in /livescores response ──────────
        if (fId && !liveIds.has(fId)) {
          try {
            const fixtureKey = `bpx:fixture:${fId}`;
            let single = await redisCache.get(fixtureKey);
            if (!single) {
              single = await poolClient.getFixtureById(fId);
              if (single && single.id) {
                await redisCache.set(fixtureKey, single, 1000);
              }
            }
            if (single && single.id) {
              addFixtures([single]);
              console.log(`[Sportmonks] ✅ Targeted fetch: ${dbM.teamA} v ${dbM.teamB} (Sportmonks ${fId})`);
            }
          } catch (singleErr) {
            // silent on single fixture poll error
          }
        }
      }

      if (liveFixtures.length === 0) {
        return 0;
      }

      for (const fixture of liveFixtures) {
        let matchInDb = await this.findMatchInDb(fixture);
        const parsed = parseSportmonksFixture(fixture, matchInDb);
        if (!parsed) continue;

        // Auto-upsert new live match if not in DB
        if (!matchInDb) {
          try {
            matchInDb = await Match.create({
              matchId: String(fixture.id),
              sportmonksFixtureId: fixture.id,
              teamA: parsed.teamA,
              teamB: parsed.teamB,
              league: parsed.league,
              startTime: new Date(fixture.starting_at || Date.now()),
              status: parsed.status,
              sportKey: 'cricket_international',
              tossMarketStatus: 'CLOSED',
              lastUpdated: new Date()
            });
            console.log(`[Sportmonks] 🏏 Auto-created LIVE match: ${matchInDb.teamA} v ${matchInDb.teamB} (ID: ${matchInDb.matchId})`);
          } catch (createErr) {
            matchInDb = await Match.findOne({ matchId: String(fixture.id) });
          }
        }

        const matchDbId = matchInDb ? matchInDb.matchId : String(fixture.id);

        // ── Change detection: check in-memory first, then Redis fallback ──
        const prevCached = this.memoryCache.get(matchDbId) || await redisCache.getScore(matchDbId);
        const hasScoreChanged = !prevCached ||
          prevCached.teamA_runs !== parsed.teamA_runs ||
          prevCached.teamB_runs !== parsed.teamB_runs ||
          prevCached.teamA_wickets !== parsed.teamA_wickets ||
          prevCached.teamB_wickets !== parsed.teamB_wickets ||
          prevCached.overs !== parsed.overs ||
          prevCached.wickets !== parsed.wickets ||
          prevCached.target !== parsed.target ||
          prevCached.status !== parsed.status ||
          prevCached.statusText !== parsed.statusText ||
          (prevCached.thisOver || []).join(',') !== (parsed.thisOver || []).join(',') ||
          prevCached.lastBall !== parsed.lastBall;

        const shouldCloseToss = matchInDb && (matchInDb.tossMarketStatus !== 'CLOSED' || matchInDb.tossBackA !== null);

        if (hasScoreChanged || shouldCloseToss) {
          const updatePayload = {
            status: parsed.status,
            winner: parsed.winner,
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
            lastUpdated: new Date()
          };

          if (shouldCloseToss) {
            updatePayload.tossMarketStatus = 'CLOSED';
            updatePayload.tossBackA = null;
            updatePayload.tossLayA = null;
            updatePayload.tossBackB = null;
            updatePayload.tossLayB = null;
            updatePayload.tossDepthBackA = '0';
            updatePayload.tossDepthLayA = '0';
            updatePayload.tossDepthBackB = '0';
            updatePayload.tossDepthLayB = '0';
          }

          const isCompleted = parsed.status === 'completed';
          if (isCompleted) {
            updatePayload.marketStatus = 'CLOSED';
            updatePayload.bookmakerMarketStatus = 'CLOSED';
            updatePayload.tossMarketStatus = 'CLOSED';
            updatePayload.backOddsA = null;
            updatePayload.layOddsA = null;
            updatePayload.backOddsB = null;
            updatePayload.layOddsB = null;
            updatePayload.bookmakerBackA = null;
            updatePayload.bookmakerLayA = null;
            updatePayload.bookmakerBackB = null;
            updatePayload.bookmakerLayB = null;
            updatePayload.tossBackA = null;
            updatePayload.tossLayA = null;
            updatePayload.tossBackB = null;
            updatePayload.tossLayB = null;
          }

          // ── Cache Update (instant, before DB write) ──
          // 1. In-memory cache (sub-ms) — primary for change detection next cycle
          this.memoryCache.set(matchDbId, parsed);
          this.memoryCache.set(String(fixture.id), parsed);
          // 2. Upstash Redis (5ms) — survives restarts, shared across instances
          const redisTTL = isCompleted ? 30000 : 2000; // 2s for live, 30s for completed
          await redisCache.setScore(matchDbId, parsed, redisTTL);
          if (String(fixture.id) !== matchDbId) {
            await redisCache.setScore(String(fixture.id), parsed, redisTTL);
          }

          // ── DB Write (debounced 5s, non-blocking on hot path) ──
          if (isCompleted) {
            // Completed: flush immediately (no debounce — settlement depends on DB state)
            await this._flushDbWrite(matchDbId, updatePayload);
          } else {
            // Live: debounce writes to max once per 5s — reduces Atlas write pressure
            this._scheduledDbWrite(matchDbId, updatePayload);
          }

          if (isCompleted) {
            const { settleMatch } = require('./settlementService');
            settleMatch(matchDbId, parsed.winner || 'VOID', this.io).catch(err => {
              console.error('[Sportmonks] Settlement error:', err.message);
            });
            if (this.io) {
              const updatedDoc = matchInDb?.toObject ? matchInDb.toObject() : matchInDb;
              this.io.emit('match_updated', { ...updatedDoc, ...updatePayload });
              this.io.emit('match_settled', {
                matchId: matchDbId,
                winner: parsed.winner,
                score: updatePayload.score
              });
              Match.find().sort({ startTime: 1 }).then(all => this.io.emit('matches_updated', all)).catch(() => {});
            }
          }

          // Real-time broadcast to all connected WebSocket clients with zero delay
          if (this.io) {
            const socketPayload = {
              matchId: matchDbId,
              score: parsed.battingTeam === 'teamB' ? parseInt(parsed.teamB_runs.split('/')[0], 10) : parseInt(parsed.teamA_runs.split('/')[0], 10),
              overs: parsed.overs,
              wickets: parsed.wickets,
              teamA_wickets: parsed.teamA_wickets,
              teamB_wickets: parsed.teamB_wickets,
              status: parsed.status,
              teamA_runs: parsed.teamA_runs,
              teamB_runs: parsed.teamB_runs,
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

            // 1. Emit for DB matchId
            this.io.emit('live_score_update', socketPayload);

            // 2. Emit with alternate 'id' prefix format so frontend matchId check never fails
            const altId = String(matchDbId).startsWith('id') ? String(matchDbId).replace(/^id/, '') : ('id' + String(matchDbId));
            this.io.emit('live_score_update', {
              ...socketPayload,
              matchId: altId
            });

            // 3. Emit for oddsApiEventId if present and different
            if (matchInDb && matchInDb.oddsApiEventId && String(matchInDb.oddsApiEventId) !== matchDbId && String(matchInDb.oddsApiEventId) !== altId) {
              this.io.emit('live_score_update', {
                ...socketPayload,
                matchId: String(matchInDb.oddsApiEventId)
              });
            }

            // 4. Emit for Sportmonks fixtureId if different
            if (String(fixture.id) !== matchDbId && String(fixture.id) !== altId) {
              this.io.emit('live_score_update', {
                ...socketPayload,
                matchId: String(fixture.id)
              });
            }

            if (shouldCloseToss) {
              const declaredTossWinner = parsed.tossWinner || matchInDb.tossWinner || null;
              this.io.emit('toss_odds_update', {
                matchId: matchDbId,
                tossMarketStatus: 'CLOSED',
                tossWinner: declaredTossWinner,
                tossSettled: Boolean(matchInDb.tossSettled || declaredTossWinner),
                tossSettledAt: matchInDb.tossSettledAt ? new Date(matchInDb.tossSettledAt).toISOString() : new Date().toISOString(),
                isLive: true,
                updatedAt: new Date()
              });
            }

            try {
              const fancyMarketsService = require('./fancyMarketsService');
              fancyMarketsService.handleLiveMatchOdds(matchDbId, this.io);
            } catch (fErr) {
              // ignore optional fancy updates
            }
          }
        }
      }

      return liveFixtures.length;
    } catch (err) {
      console.error('[SportmonksScoreService] ❌ Sync Error:', err.message);
      return 0;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Start adaptive real-time live score sync loop
   */
  startLiveScoreEngine(io) {
    this.io = io;
    console.log('⚡ [Sportmonks] Real-Time Live Score Engine initialized (1.5s live / 6s idle adaptive loop)');

    const scheduleNext = (delayMs) => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        try {
          const liveCount = await this.syncLiveScores(this.io);
          const nextInterval = (liveCount > 0) ? this.pollIntervalLive : this.pollIntervalIdle;
          scheduleNext(nextInterval);
        } catch (e) {
          scheduleNext(this.pollIntervalIdle);
        }
      }, delayMs);
    };

    // Immediate initial sync
    this.syncLiveScores(io).then((count) => {
      const interval = (count > 0) ? this.pollIntervalLive : this.pollIntervalIdle;
      scheduleNext(interval);
    }).catch(() => {
      scheduleNext(this.pollIntervalIdle);
    });
  }

  /**
   * Get latest cached or DB score for a matchId
   */
  async getLiveScore(matchId) {
    if (this.memoryCache.has(matchId)) {
      return this.memoryCache.get(matchId);
    }
    const match = await Match.findOne({
      $or: [{ matchId }, { sportmonksFixtureId: Number(matchId) || 0 }]
    });
    if (match && match.score) {
      return {
        matchId: match.matchId,
        teamA: match.teamA,
        teamB: match.teamB,
        status: match.status,
        ...match.score
      };
    }
    return null;
  }
}

const serviceInstance = new SportmonksScoreService();

module.exports = {
  sportmonksScoreService: serviceInstance,
  parseSportmonksFixture,
  formatBallBadge
};
