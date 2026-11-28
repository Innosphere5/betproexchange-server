const Match = require('../models/Match');
const redisCache = require('./upstashRedisCache');
const { shouldIncludeFixture, getCricketPriority, getMatchScheduleWindow } = require('./fixtureFilter');

/**
 * Projection excluding heavy per-market nested arrays (`fancyMarkets`, `figureMarkets`,
 * `evenOddMarkets`, `tiedMatchMarket`, `score.batsmen`) for catalog endpoints.
 * Shrinks `/api/matches` payload ~10x (from ~200 KB to ~20 KB) for instant UI load.
 */
const SLIM_CATALOG_PROJECTION = '-fancyMarkets -betfairFancyMarkets -figureMarkets -evenOddMarkets -tiedMatchMarket -matchOddsDepth -oddsData -score.batsmen';

/** Deduplicate matches by normalized teams + date, always keeping `live` and priced entries. */
function deduplicateMatches(matches) {
  const uniqueMap = new Map();
  for (const m of matches || []) {
    const mObj = m.toObject ? m.toObject() : m;
    if (!mObj.teamA || !mObj.teamB) continue;
    const dateKey = mObj.startTime ? new Date(mObj.startTime).toISOString().slice(0, 10) : 'nodate';
    const teamsKey = [mObj.teamA.trim().toLowerCase(), mObj.teamB.trim().toLowerCase()].sort().join('-');
    const key = `${teamsKey}_${dateKey}`;

    if (uniqueMap.has(key)) {
      const existing = uniqueMap.get(key);
      const mHasOdds = mObj.backOddsA != null || mObj.backOddsB != null;
      const existingHasOdds = existing.backOddsA != null || existing.backOddsB != null;
      const mHasScore = Boolean(mObj.roanuzMatchKey || (mObj.score?.overs && mObj.score.overs !== '0.0' && mObj.score.overs !== '0'));
      const existingHasScore = Boolean(existing.roanuzMatchKey || (existing.score?.overs && existing.score.overs !== '0.0' && existing.score.overs !== '0'));

      if (mObj.status === 'live' && existing.status !== 'live') {
        uniqueMap.set(key, mObj);
      } else if (mObj.status === existing.status) {
        if (mHasScore && !existingHasScore) {
          uniqueMap.set(key, mObj);
        } else if (!mHasScore && existingHasScore) {
          // keep existing with verified live score / Roanuz link
        } else if (mHasOdds && !existingHasOdds) {
          uniqueMap.set(key, mObj);
        } else if (!mHasOdds && existingHasOdds) {
          // keep existing with odds
        } else {
          uniqueMap.set(key, mObj);
        }
      }
    } else {
      uniqueMap.set(key, mObj);
    }
  }
  return Array.from(uniqueMap.values());
}

/** Merge live Roanuz in-memory scores when available so dashboard cards stay fresh. */
async function attachHotScore(match) {
  try {
    const { roanuzScoreService } = require('./roanuzScoreService');
    const hotScore = await roanuzScoreService.getLiveScoreForMatch(match);
    if (hotScore) {
      return {
        ...match,
        score: {
          ...(match.score || {}),
          ...hotScore,
        }
      };
    }
  } catch (_) {}
  return match;
}

/** Sort catalog with LIVE matches strictly first, then priority, then startTime ascending. */
function sortCatalogMatches(matches) {
  return [...matches].sort((a, b) => {
    const isLiveA = a.status === 'live';
    const isLiveB = b.status === 'live';
    if (isLiveA !== isLiveB) return isLiveB ? 1 : -1;

    const prioA = getCricketPriority(a);
    const prioB = getCricketPriority(b);
    if (prioB !== prioA) return prioB - prioA;

    const timeA = new Date(a.startTime || 0).getTime();
    const timeB = new Date(b.startTime || 0).getTime();
    return timeA - timeB;
  });
}

/** Fetch slim live matches, deduplicated and cached in L1/Redis. */
async function getLiveMatchesList({ bypassCache = false } = {}) {
  if (!bypassCache) {
    const cached = await redisCache.getLiveMatches();
    if (Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
  }

  const liveMatches = await Match.find({
    status: 'live',
    $or: [{ winner: null }, { winner: { $exists: false } }]
  })
    .select(SLIM_CATALOG_PROJECTION)
    .sort({ startTime: -1 })
    .lean();

  const now = new Date();
  const filtered = deduplicateMatches(liveMatches)
    .filter((match) => shouldIncludeFixture(match, now));

  const enriched = await Promise.all(filtered.map(attachHotScore));
  await redisCache.setLiveMatches(enriched, 5000);
  return enriched;
}

/** Fetch slim active catalog (live + upcoming), live-sorted and cached in L1/Redis. */
async function getAllMatchesList({ bypassCache = false } = {}) {
  if (!bypassCache) {
    const cached = await redisCache.getAllMatches();
    if (Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
  }

  const now = new Date();
  const { windowStartDate, windowEndDate } = getMatchScheduleWindow(now);

  const matches = await Match.find({
    status: { $in: ['live', 'upcoming'] },
    $and: [
      { $or: [{ winner: null }, { winner: { $exists: false } }] },
      { $or: [{ status: 'live' }, { startTime: { $gte: windowStartDate, $lte: windowEndDate } }] }
    ]
  })
    .select(SLIM_CATALOG_PROJECTION)
    .sort({ startTime: 1 })
    .lean();

  const deduped = sortCatalogMatches(
    deduplicateMatches(matches)
      .filter((match) => shouldIncludeFixture(match, now) && match.status !== 'completed' && match.status !== 'resulted' && !match.winner)
  );

  for (let i = 0; i < deduped.length; i++) {
    const match = deduped[i];
    if (match.status === 'live') {
      deduped[i] = await attachHotScore(match);
    }
    const isMatchCompleted = match.status === 'completed' || match.status === 'resulted' || Boolean(match.winner);
    const isMatchLive = match.status === 'live' || (match.startTime && now >= new Date(match.startTime));
    if (!isMatchCompleted && !isMatchLive && !match.tossWinner && match.tossMarketStatus !== 'CLOSED') {
      deduped[i].tossBackA = 1.98;
      deduped[i].tossLayA = 2.02;
      deduped[i].tossBackB = 1.98;
      deduped[i].tossLayB = 2.02;
      deduped[i].tossMarketStatus = 'OPEN';
    }
  }

  await redisCache.setAllMatches(deduped, 10000);
  return deduped;
}

let warmInFlight = false;
let warmerInterval = null;
let warmCount = 0;

/** Warm L1/Redis match caches proactively so user HTTP requests never hit cold MongoDB. */
async function warmMatchCatalog({ forceAll = false } = {}) {
  if (warmInFlight) return;
  warmInFlight = true;
  try {
    warmCount++;
    await getLiveMatchesList({ bypassCache: true });
    if (forceAll || warmCount % 3 === 1) {
      await getAllMatchesList({ bypassCache: true });
    }
  } catch (err) {
    console.warn('[MatchCatalog] Warm warning:', err.message);
  } finally {
    warmInFlight = false;
  }
}

/** Invalidate match caches, fetch active-only list, and broadcast `matches_updated` to clients. */
async function broadcastActiveCatalog(io) {
  await redisCache.invalidateMatchCatalogs().catch(() => {});
  const activeMatches = await getAllMatchesList({ bypassCache: true });
  if (io) {
    io.emit('matches_updated', activeMatches);
  }
  return activeMatches;
}

/** Start background catalog cache warmer (every 3s for live, every 9s for full catalog). */
function startCatalogWarmer() {
  if (warmerInterval) return;
  warmMatchCatalog({ forceAll: true }).catch(() => {});
  warmerInterval = setInterval(() => {
    warmMatchCatalog().catch(() => {});
  }, 3000);
  if (typeof warmerInterval.unref === 'function') warmerInterval.unref();
  console.log('⚡ MatchCatalog background cache warmer active (3s live / 9s full)');
}

module.exports = {
  SLIM_CATALOG_PROJECTION,
  deduplicateMatches,
  sortCatalogMatches,
  getLiveMatchesList,
  getAllMatchesList,
  broadcastActiveCatalog,
  warmMatchCatalog,
  startCatalogWarmer,
};
