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
  const repr = String(ball.repr || '').toLowerCase().trim();
  const ballType = String(ball.ball_type || '').toLowerCase().trim();
  const isWicket = Boolean(ball.wicket || ball.is_wicket || ball.team_score?.is_wicket || /\bw\d*\b/.test(repr));
  const runs = Number(ball.team_score?.runs ?? ball.batsman?.runs ?? 0);

  const isWide = ballType === 'wide' || /\bwd\d*\b|\d*wd\b/.test(repr) || repr.includes('wd');
  if (isWide) {
    const base = runs > 1 ? `${runs}Wd` : 'Wd';
    return isWicket ? `${base}+W` : base;
  }

  const isNoBall = ballType === 'no_ball' || ballType === 'noball' || /\bnb\d*\b|\d*nb\b/.test(repr) || repr.includes('nb');
  if (isNoBall) {
    const base = runs > 1 ? `${runs}Nb` : 'Nb';
    return isWicket ? `${base}+W` : base;
  }

  if (isWicket) return 'W';

  const isLegBye = ballType === 'leg_bye' || ballType === 'legbye' || /\blb\d*\b|\d*lb\b/.test(repr) || repr.includes('lb');
  if (isLegBye) {
    return runs > 1 ? `${runs}Lb` : 'Lb';
  }

  const isBye = ballType === 'bye' || ballType === 'byes' || /\bb\d+\b|^b$/.test(repr);
  if (isBye) {
    return runs > 1 ? `${runs}B` : 'B';
  }

  if (/^r\d+$/.test(repr)) {
    const rVal = ball.team_score?.runs ?? Number(repr.slice(1));
    return String(Number.isFinite(Number(rVal)) ? rVal : 0);
  }

  return String(Number.isFinite(runs) ? runs : 0);
}

/**
 * Format compact Roanuz ball_repr string into standard cricket badge
 */
function formatReprBadge(reprStr) {
  if (!reprStr) return '0';
  const str = String(reprStr).toLowerCase().trim();
  const numMatch = str.match(/(\d+)/);
  const num = numMatch ? Number(numMatch[1]) : 0;
  const hasWicket = /\bw\b|^w\d*$|,w\b|\bw,/.test(str);

  if (str.includes('wd')) {
    const base = num > 1 ? `${num}Wd` : 'Wd';
    return hasWicket ? `${base}+W` : base;
  }
  if (str.includes('nb')) {
    const base = num > 1 ? `${num}Nb` : 'Nb';
    return hasWicket ? `${base}+W` : base;
  }
  if (hasWicket) return 'W';
  if (str.includes('lb')) return num > 1 ? `${num}Lb` : 'Lb';
  if (/^b\d*$|\bb\d*\b/.test(str)) return num > 1 ? `${num}B` : 'B';
  if (/^[re]\d+$/.test(str)) return String(num);
  return str.replace(/^r/, '') || '0';
}

/**
 * Chronological comparator for Roanuz ball-by-ball objects (ascending: ball 1 -> ball 6)
 */
function compareRoanuzBalls(a, b) {
  const ovA0 = Number(a?.overs?.[0] ?? 0);
  const ovB0 = Number(b?.overs?.[0] ?? 0);
  if (ovA0 !== ovB0) return ovA0 - ovB0;
  const ovA1 = Number(a?.overs?.[1] ?? 0);
  const ovB1 = Number(b?.overs?.[1] ?? 0);
  if (ovA1 !== ovB1) return ovA1 - ovB1;
  const keyA = Number(a?.key);
  const keyB = Number(b?.key);
  if (Number.isFinite(keyA) && Number.isFinite(keyB) && keyA !== keyB) {
    return keyA - keyB;
  }
  return 0;
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

  const safeNum = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // Overs
  let currentOvers = 0.0;
  if (Array.isArray(live.score?.overs)) {
    const ovWhole = safeNum(live.score.overs[0], 0);
    const ovBalls = safeNum(live.score.overs[1], 0);
    currentOvers = safeNum(`${ovWhole}.${ovBalls}`, 0);
  } else if (live.score?.overs !== undefined && live.score?.overs !== null) {
    currentOvers = safeNum(live.score.overs, 0);
  }

  // Target and required run rate
  let target = safeNum(play.target?.runs, 0);
  let reqRunRate = "0.00";
  let remRuns = 0;
  let remBalls = 0;

  const maxOvers = safeNum(
    play.overs_per_innings,
    matchData.format === 't20' ? 20 :
    matchData.format === 'oneday' ? 50 :
    matchData.format === 't10' ? 10 : 20
  );
  const totalBallsMax = maxOvers * 6;

  if (target > 0) {
    remRuns = Math.max(0, target - safeNum(currentScore, 0));
    const derivedBalls = Math.floor(currentOvers) * 6 + Math.round((currentOvers % 1) * 10);
    const innBalls = Number.isFinite(Number(live.score?.balls)) ? Number(live.score.balls) : derivedBalls;
    remBalls = Math.max(0, safeNum(totalBallsMax - innBalls, 0));
    if (remBalls > 0 && remRuns > 0) {
      reqRunRate = ((remRuns / remBalls) * 6).toFixed(2);
    }
  }

  // Run Rate
  const runRate = live.score?.run_rate ? Number(live.score.run_rate).toFixed(2) : "0.00";

  // Ball-by-ball thisOver & prevOver calculation (sorted chronologically ascending & over-aligned)
  let thisOver = [];
  let prevOver = [];
  let lastBallText = '';

  const ovWholeLive = Math.floor(currentOvers);
  const ovBallsLive = Array.isArray(live.score?.overs)
    ? safeNum(live.score.overs[1], 0)
    : Math.round((currentOvers % 1) * 10);

  if (ovWholeLive > 0 || ovBallsLive > 0) {
    // When ballsInCurOver > 0 (e.g. [85, 2]), the active over 0-based index is ovWholeLive (85).
    // When ballsInCurOver === 0 (e.g. [85, 0]), the just-completed over 0-based index is ovWholeLive - 1 (84).
    const targetOverZeroIdx = ovBallsLive > 0 ? ovWholeLive : Math.max(0, ovWholeLive - 1);

    const bbbOver = ballByBallData?.data?.over;
    const bbbInnings = bbbOver?.index?.innings;
    const validBbbInnings = !live.innings || !bbbInnings || bbbInnings === live.innings;
    const rawBbbBalls = validBbbInnings && Array.isArray(bbbOver?.balls) ? [...bbbOver.balls] : [];

    // Filter balls belonging to the target over (fallback to all balls in over response only when over_number matches)
    const matchingBbbBalls = rawBbbBalls.filter(
      (b) => Array.isArray(b?.overs) && Number(b.overs[0]) === targetOverZeroIdx
    );
    const overMatchesIndex = Number(bbbOver?.index?.over_number) === targetOverZeroIdx + 1;
    const candidateBbbBalls = matchingBbbBalls.length > 0
      ? matchingBbbBalls
      : (overMatchesIndex ? rawBbbBalls : []);

    candidateBbbBalls.sort(compareRoanuzBalls);

    // Match live.recent_overs_repr entry for the exact same active over + previous over
    const reprList = Array.isArray(live.recent_overs_repr) ? live.recent_overs_repr : [];
    const matchingRepr = reprList.find((o) => Number(o?.overnumber) === targetOverZeroIdx);
    const reprBalls = Array.isArray(matchingRepr?.ball_repr) ? matchingRepr.ball_repr.map(formatReprBadge) : [];

    if (targetOverZeroIdx > 0) {
      const prevRepr = reprList.find((o) => Number(o?.overnumber) === targetOverZeroIdx - 1);
      if (Array.isArray(prevRepr?.ball_repr)) {
        prevOver = prevRepr.ball_repr.map(formatReprBadge);
      }
    }

    // Primary: sorted ballByBall entries for the active over (richer commentary + ball_type + wicket flags).
    // Fallback: live.recent_overs_repr for that same active over when ballByBall is unavailable or lagged behind.
    if (candidateBbbBalls.length > 0) {
      thisOver = candidateBbbBalls.map(formatRoanuzBallBadge);
      const lastBallObj = candidateBbbBalls[candidateBbbBalls.length - 1];
      if (lastBallObj) {
        const ovStr = Array.isArray(lastBallObj.overs) ? `${lastBallObj.overs[0]}.${lastBallObj.overs[1]}` : '';
        const rawComment = String(lastBallObj.comment || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        lastBallText = `${ovStr ? ovStr + ': ' : ''}${rawComment}`;
      }
    } else if (reprBalls.length > 0) {
      thisOver = reprBalls;
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

  // Match format
  const roanuzFormat = String(matchData.format || '').toLowerCase();
  const detectedFormat = (roanuzFormat === 'oneday' || roanuzFormat === 'odi' || maxOvers === 50) ? 'ODI' :
                         (roanuzFormat === 'test') ? 'TEST' : 'T20';

  // Active Innings Stats (fours, sixes, extras, recentOvers)
  const activeInnObj = innings[live.innings] || (isTeamABatting ? (innA2 || innA1) : (innB2 || innB1)) || {};
  const calcExtraTotal = (ex) => {
    if (!ex) return 0;
    if (typeof ex.total === 'number') return ex.total;
    if (typeof ex === 'number') return ex;
    return (Number(ex.bye || 0) + Number(ex.leg_bye || 0) + Number(ex.wide || 0) + Number(ex.no_ball || 0) + Number(ex.penalty || 0));
  };
  const activePlayersFours = batsmen.reduce((s, b) => s + (Number(b.fours) || 0), 0);
  const activePlayersSixes = batsmen.reduce((s, b) => s + (Number(b.sixes) || 0), 0);
  const inningsStats = {
    fours: safeNum(activeInnObj.score?.fours ?? activeInnObj.batting_stats?.fours ?? activeInnObj.fours, activePlayersFours),
    sixes: safeNum(activeInnObj.score?.sixes ?? activeInnObj.batting_stats?.sixes ?? activeInnObj.sixes, activePlayersSixes),
    extras: safeNum(activeInnObj.extra_runs?.total ?? calcExtraTotal(activeInnObj.extra_runs ?? activeInnObj.extras ?? activeInnObj.score?.extras), 0),
    oversCount: Array.isArray(activeInnObj.overs) ? Number(`${activeInnObj.overs[0]}.${activeInnObj.overs[1]}`) : currentOvers,
  };

  return {
    matchId: String(matchData.key),
    roanuzMatchKey: matchData.key,
    teamA: matchInDb ? matchInDb.teamA : teamAName,
    teamB: matchInDb ? matchInDb.teamB : teamBName,
    league: matchData.tournament?.name || 'Cricket',
    format: detectedFormat,
    oversPerInnings: maxOvers,
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
    prevOver,
    inningsStats,
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
    this.DB_WRITE_DEBOUNCE_MS = 1200; // Fast DB persistence (~1.2s) so REST and reloads stay in sync
    this.lastPreTossCheck = new Map(); // roanuzKey -> timestampMs
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
   * Find ALL matching non-completed Match docs in MongoDB (handles reissued Oddspapi fixtures
   * or swapped home/away team docs) and auto-links `roanuzMatchKey`.
   */
  async findMatchesInDb(roanuzMatch) {
    const key = roanuzMatch.key;
    const seenIds = new Set();
    const matched = [];

    const directMatches = await Match.find({
      $or: [
        { roanuzMatchKey: key },
        { matchId: key }
      ]
    });
    for (const m of directMatches) {
      if (!seenIds.has(m.matchId)) {
        seenIds.add(m.matchId);
        matched.push(m);
      }
    }

    const nameA = roanuzMatch.teams?.a?.name;
    const nameB = roanuzMatch.teams?.b?.name;
    if (nameA && nameB) {
      const normA = normalizeTeamName(nameA);
      const normB = normalizeTeamName(nameB);
      const roanuzStartMs = roanuzMatch.start_at ? Number(roanuzMatch.start_at) * 1000 : null;

      const candidates = await Match.find({
        status: { $in: ['live', 'upcoming'] }
      }).lean();

      for (const cand of candidates) {
        if (seenIds.has(cand.matchId)) continue;
        const candA = normalizeTeamName(cand.teamA);
        const candB = normalizeTeamName(cand.teamB);

        const matchDirect = candA === normA && candB === normB;
        const matchReversed = candA === normB && candB === normA;
        if (!matchDirect && !matchReversed) continue;

        // Guard against linking a future match in a multi-game bilateral series (>30h away)
        if (roanuzStartMs && cand.startTime) {
          const diffHours = Math.abs(new Date(cand.startTime).getTime() - roanuzStartMs) / 3600000;
          if (diffHours > 30) continue;
        }

        await Match.updateOne({ matchId: cand.matchId }, { $set: { roanuzMatchKey: key } }).catch(() => {});
        cand.roanuzMatchKey = key;
        seenIds.add(cand.matchId);
        matched.push(cand);
        console.log(`[Roanuz] 🔗 Linked ${cand.teamA} v ${cand.teamB} (DB matchId: ${cand.matchId}) → Roanuz ${key}`);
      }
    }

    return matched;
  }

  /**
   * Find first matching match in MongoDB by Roanuz key or fuzzy team matching
   */
  async findMatchInDb(roanuzMatch) {
    const all = await this.findMatchesInDb(roanuzMatch);
    return all[0] || null;
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

      const nowSec = Math.floor(Date.now() / 1000);
      const activeMatches = [];
      const preTossCandidates = [];
      for (const d of days) {
        for (const m of (d.matches || [])) {
          if (m.status === 'started' || m.status === 'live' || m.play_status === 'in_play') {
            activeMatches.push(m);
          } else if (
            m.status !== 'completed' &&
            m.start_at &&
            m.start_at >= nowSec - 45 * 60 &&
            m.start_at <= nowSec + 45 * 60
          ) {
            const lastChk = this.lastPreTossCheck.get(m.key) || 0;
            if (Date.now() - lastChk >= 15000) {
              this.lastPreTossCheck.set(m.key, Date.now());
              preTossCandidates.push(m);
            }
          }
        }
      }

      // Check pre-match toss declarations (happens 10-30m before first ball)
      for (const candMatch of preTossCandidates) {
        try {
          const matchDetail = await roanuzClient.getMatch(candMatch.key);
          const matchData = matchDetail?.data;
          if (!matchData?.toss?.winner) continue;
          const matchInDb = await this.findMatchInDb(matchData);
          if (!matchInDb) continue;

          const parsedPre = parseRoanuzMatch(matchData, null, matchInDb);
          if (!parsedPre?.tossWinner) continue;

          const needsDbUpdate =
            matchInDb.tossWinner !== parsedPre.tossWinner ||
            matchInDb.tossDecision !== parsedPre.tossDecision ||
            matchInDb.tossMarketStatus !== 'CLOSED';

          if (needsDbUpdate) {
            await Match.updateOne(
              { matchId: matchInDb.matchId },
              {
                $set: {
                  tossWinner: parsedPre.tossWinner,
                  tossDecision: parsedPre.tossDecision || null,
                  tossMarketStatus: 'CLOSED',
                  tossBackA: null,
                  tossLayA: null,
                  tossBackB: null,
                  tossLayB: null,
                  lastUpdated: new Date()
                }
              }
            ).catch(() => {});

            if (this.io) {
              const altId = String(matchInDb.matchId).startsWith('id')
                ? String(matchInDb.matchId).replace(/^id/, '')
                : ('id' + String(matchInDb.matchId));
              for (const tid of [matchInDb.matchId, altId]) {
                this.io.emit('toss_odds_update', {
                  matchId: tid,
                  tossMarketStatus: 'CLOSED',
                  tossWinner: parsedPre.tossWinner,
                  tossDecision: parsedPre.tossDecision || null,
                  tossBackA: null,
                  tossLayA: null,
                  tossBackB: null,
                  tossLayB: null
                });
                this.io.emit('live_score_update', {
                  matchId: tid,
                  status: matchInDb.status,
                  tossWinner: parsedPre.tossWinner,
                  tossDecision: parsedPre.tossDecision || null
                });
              }
            }
          }
        } catch (_) {}
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

          // Find all matching DB docs (handles reissued fixtures) or create if none
          let targetMatches = await this.findMatchesInDb(matchData);
          if (targetMatches.length === 0) {
            // Auto-create live match if not in DB so it's instantly bettable & visible
            const newMatchId = String(matchData.key);
            const teamA = matchData.teams?.a?.name || 'Team A';
            const teamB = matchData.teams?.b?.name || 'Team B';
            const league = matchData.tournament?.name || 'Cricket';

            try {
              const roanuzFormat = String(matchData.format || '').toLowerCase();
              const autoFormat = (roanuzFormat === 'oneday' || roanuzFormat === 'odi') ? 'ODI' : (roanuzFormat === 'test' ? 'TEST' : 'T20');
              const created = await Match.create({
                matchId: newMatchId,
                roanuzMatchKey: matchData.key,
                teamA,
                teamB,
                league,
                format: autoFormat,
                status: 'live',
                startTime: new Date(matchData.start_at ? matchData.start_at * 1000 : Date.now()),
                score: {
                  format: autoFormat
                }
              });
              targetMatches = [created];
              console.log(`[Roanuz] 🆕 Auto-created live match in DB: ${teamA} v ${teamB} (${newMatchId})`);
            } catch (createErr) {
              const existing = await Match.findOne({ matchId: newMatchId });
              if (existing) targetMatches = [existing];
            }
          }

          for (const matchInDb of targetMatches) {
          const parsed = parseRoanuzMatch(matchData, ballByBall, matchInDb);
          if (!parsed) continue;

          const matchDbId = matchInDb ? matchInDb.matchId : String(matchData.key);
          const altDbId = String(matchDbId).startsWith('id') ? String(matchDbId).replace(/^id/, '') : ('id' + String(matchDbId));

          // Update memory cache for both IDs
          this.memoryCache.set(matchDbId, parsed);
          this.memoryCache.set(altDbId, parsed);
          this.memoryCache.set(String(matchData.key), parsed);

          // Update Redis cache (12s = 12000ms TTL)
          await redisCache.setScore(matchDbId, parsed, 12000).catch(() => {});
          await redisCache.setScore(altDbId, parsed, 12000).catch(() => {});

          // Debounced DB persistence
          const dbPayload = {
            status: parsed.status,
            format: parsed.format,
            roanuzMatchKey: matchData.key,
            score: {
              format: parsed.format,
              oversPerInnings: parsed.oversPerInnings,
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
              prevOver: parsed.prevOver,
              inningsStats: parsed.inningsStats,
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
            lastUpdated: new Date()
          };
          if (parsed.status === 'completed') {
            dbPayload.completedAt = matchInDb?.completedAt || new Date();
          }
          if (parsed.tossWinner) dbPayload.tossWinner = parsed.tossWinner;
          if (parsed.tossDecision) dbPayload.tossDecision = parsed.tossDecision;
          this._scheduledDbWrite(matchDbId, dbPayload);
          if (parsed.status === 'completed') {
            const supabaseService = require('./supabaseService');
            supabaseService.archiveCompletedMatchResult({ ...(matchInDb?.toObject ? matchInDb.toObject() : matchInDb), ...dbPayload, matchId: matchDbId }).catch(() => {});
          }

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
              prevOver: parsed.prevOver,
              inningsStats: parsed.inningsStats,
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
    const cleanId = String(matchId);
    const altId = cleanId.startsWith('id') ? cleanId.replace(/^id/, '') : ('id' + cleanId);

    // 1. In-process cache (0ms)
    if (this.memoryCache.has(cleanId)) return this.memoryCache.get(cleanId);
    if (this.memoryCache.has(altId)) return this.memoryCache.get(altId);

    // 2. Redis cache (sub-5ms)
    const cached = await redisCache.getScore(cleanId).catch(() => null) ||
                   await redisCache.getScore(altId).catch(() => null);
    if (cached) {
      this.memoryCache.set(cleanId, cached);
      this.memoryCache.set(altId, cached);
      return cached;
    }

    // 3. Fallback to MongoDB (only when connected)
    if (Match.db?.readyState === 1) {
      const match = await Match.findOne({
        $or: [
          { matchId: cleanId },
          { matchId: altId },
          { roanuzMatchKey: cleanId },
          { roanuzMatchKey: altId }
        ]
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
        this.memoryCache.set(cleanId, scoreObj);
        this.memoryCache.set(altId, scoreObj);
        return scoreObj;
      }
    }

    return null;
  }

  /**
   * Align a live score object from a sibling match doc (which may have teamA/teamB swapped)
   * onto the requested match's teamA/teamB order.
   */
  alignScoreToMatchTeams(scoreObj, targetMatch) {
    if (!scoreObj || !targetMatch?.teamA || !targetMatch?.teamB) return scoreObj;
    const tA = normalizeTeamName(targetMatch.teamA);
    const tB = normalizeTeamName(targetMatch.teamB);
    const sA = normalizeTeamName(scoreObj.teamA);
    const sB = normalizeTeamName(scoreObj.teamB);
    if (!sA || !sB || (sA === tA && sB === tB)) return scoreObj;
    if (sA !== tB || sB !== tA) return scoreObj;

    return {
      ...scoreObj,
      teamA: targetMatch.teamA,
      teamB: targetMatch.teamB,
      teamA_runs: scoreObj.teamB_runs,
      teamB_runs: scoreObj.teamA_runs,
      teamA_wickets: scoreObj.teamB_wickets,
      teamB_wickets: scoreObj.teamA_wickets,
      battingTeam: scoreObj.battingTeam === 'teamA' ? 'teamB' : (scoreObj.battingTeam === 'teamB' ? 'teamA' : scoreObj.battingTeam),
    };
  }

  /**
   * Resolves the freshest live score for a match doc, falling back to any active
   * sibling match in memoryCache or MongoDB sharing the same teams within 30h.
   */
  async getLiveScoreForMatch(match) {
    if (!match) return null;
    const hasProgress = (s) => Boolean(
      s && ((s.overs && s.overs !== '0' && s.overs !== '0.0') ||
      (parseInt(String(s.teamA_runs || '0').split('/')[0], 10) || 0) > 0 ||
      (parseInt(String(s.teamB_runs || '0').split('/')[0], 10) || 0) > 0)
    );

    const direct = await this.getLiveScore(match.matchId) ||
      (match.roanuzMatchKey ? await this.getLiveScore(match.roanuzMatchKey) : null);
    if (hasProgress(direct)) return direct;

    // Search memoryCache by team names
    const tA = normalizeTeamName(match.teamA);
    const tB = normalizeTeamName(match.teamB);
    if (tA && tB) {
      for (const cached of this.memoryCache.values()) {
        const cA = normalizeTeamName(cached?.teamA);
        const cB = normalizeTeamName(cached?.teamB);
        if (hasProgress(cached) && ((cA === tA && cB === tB) || (cA === tB && cB === tA))) {
          return this.alignScoreToMatchTeams(cached, match);
        }
      }

      // Search MongoDB siblings with live Roanuz scores (within 30h window)
      if (Match.db?.readyState === 1) {
        const siblings = await Match.find({
          matchId: { $ne: match.matchId },
          status: { $in: ['live', 'completed'] },
        }).lean();
        const targetStartMs = match.startTime ? new Date(match.startTime).getTime() : null;
        for (const sib of siblings) {
          const sA = normalizeTeamName(sib.teamA);
          const sB = normalizeTeamName(sib.teamB);
          if (!((sA === tA && sB === tB) || (sA === tB && sB === tA))) continue;
          if (targetStartMs && sib.startTime) {
            const diffH = Math.abs(new Date(sib.startTime).getTime() - targetStartMs) / 3600000;
            if (diffH > 30) continue;
          }
          if (hasProgress(sib.score)) {
            return this.alignScoreToMatchTeams({
              matchId: match.matchId,
              teamA: sib.teamA,
              teamB: sib.teamB,
              ...sib.score,
            }, match);
          }
        }
      }
    }

    return direct;
  }
}

const serviceInstance = new RoanuzScoreService();

module.exports = {
  roanuzScoreService: serviceInstance,
  parseRoanuzMatch,
  formatRoanuzBallBadge,
  formatReprBadge,
  compareRoanuzBalls,
};
