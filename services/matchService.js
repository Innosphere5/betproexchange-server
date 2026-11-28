const Match = require("../models/Match");
const MarketOdds = require("../models/MarketOdds");
const OddsMarket = require("../models/OddsMarket");
const supabaseService = require("./supabaseService");
const { getData } = require("./apiManager");
const {
  shouldIncludeFixture,
  getMatchScheduleWindow,
  isTestMatchFormat,
  selectDisplayableFixtures,
  getCricketPriority,
  getMatchFormat,
  isInternationalFixture,
  isTopFranchiseLeague,
  isVirtualOrSimulated,
} = require("./fixtureFilter");
const {
  selectAccurateMatchOddsMarket,
  extractRunnerDepthFromQuote,
} = require("./oddspapiCricketCatalog");

/**
 * Extracts Match Odds (h2h / winner) from oddspapi odds response.
 * Prefers Betfair Exchange quotes with full back/lay market depth.
 */
function extractMatchOdds(oddsResponse, fixtureHint = null) {
  if (!oddsResponse || !oddsResponse.odds) return null;

  const bookmakers = oddsResponse.odds;
  const preferredBookies = ["betfair-ex", "betfair_ex", "pinnacle"];

  let targetQuotes = null;
  let usedBookie = null;

  for (const b of preferredBookies) {
    if (bookmakers[b] && Object.keys(bookmakers[b]).length > 0) {
      targetQuotes = bookmakers[b];
      usedBookie = b;
      break;
    }
  }

  if (!targetQuotes) {
    const keys = Object.keys(bookmakers);
    if (keys.length > 0) {
      targetQuotes = bookmakers[keys[0]];
      usedBookie = keys[0];
    }
  }

  if (!targetQuotes) return null;

  const isExchange = usedBookie.includes("ex");
  const quotesList = Object.values(targetQuotes).filter(
    (q) => q && q.active !== false,
  );

  // Group by marketId
  const byMarket = {};
  for (const q of quotesList) {
    const mId = q.marketId ?? "default";
    if (!byMarket[mId]) byMarket[mId] = [];
    byMarket[mId].push(q);
  }

  const isTest = isTestMatchFormat(fixtureHint || oddsResponse);

  // Select accurate Match Odds market:
  // - Non-Test (T10/T20/ODI): prioritize market 271 (Winner) over 273 (1X2)
  // - Test: prioritize market 273 (1X2 incl. Draw)
  let winnerMarket = selectAccurateMatchOddsMarket(byMarket, isTest);

  if (!winnerMarket || winnerMarket.length < 2) return null;

  let homeQ = null;
  let awayQ = null;
  let drawQ = null;

  if (winnerMarket.length === 3) {
    drawQ = winnerMarket.find(q => {
      const name = String(q.outcomeName || q.name || q.label || '').trim().toLowerCase();
      return q.outcomeId === 274 || name === 'x' || name === 'the draw' || name === 'draw' || name === 'tie';
    });

    const nonDraw = winnerMarket.filter(q => q !== drawQ);
    nonDraw.sort((a, b) => (Number(a.outcomeId) || 0) - (Number(b.outcomeId) || 0));
    homeQ = nonDraw[0];
    awayQ = nonDraw[1];
  } else {
    winnerMarket.sort(
      (a, b) => (Number(a.outcomeId) || 0) - (Number(b.outcomeId) || 0),
    );
    homeQ = winnerMarket[0];
    awayQ = winnerMarket[1];
  }

  if (!homeQ || !awayQ) return null;

  const homeDepth = extractRunnerDepthFromQuote(homeQ, isExchange, isExchange ? "0" : "500");
  const awayDepth = extractRunnerDepthFromQuote(awayQ, isExchange, isExchange ? "0" : "500");
  const drawDepth = drawQ ? extractRunnerDepthFromQuote(drawQ, isExchange, isExchange ? "0" : "500") : null;

  const backOddsA = homeDepth.back || null;
  const layOddsA = homeDepth.lay || null;
  const depthBackA = homeDepth.backVol;
  const depthLayA = homeDepth.layVol;

  const backOddsB = awayDepth.back || null;
  const layOddsB = awayDepth.lay || null;
  const depthBackB = awayDepth.backVol;
  const depthLayB = awayDepth.layVol;

  let backOddsDraw = drawDepth ? (drawDepth.back || null) : null;
  let layOddsDraw = drawDepth ? (drawDepth.lay || null) : null;
  let depthBackDraw = drawDepth ? drawDepth.backVol : "0";
  let depthLayDraw = drawDepth ? drawDepth.layVol : "0";

  if (!isTest) {
    // Only Test / First-Class matches display The Draw; T10 / T20 / ODI use Tied Match in footer
    backOddsDraw = null;
    layOddsDraw = null;
    depthBackDraw = "0";
    depthLayDraw = "0";
  } else if ((!backOddsDraw || backOddsDraw === 0) && backOddsA > 1 && backOddsB > 1) {
    const probA = 1 / backOddsA;
    const probB = 1 / backOddsB;
    const probDraw = Math.max(0.01, 1.02 - (probA + probB));
    backOddsDraw = Number((1 / probDraw).toFixed(2));
    layOddsDraw = Number((backOddsDraw + 0.02).toFixed(2));
    depthBackDraw = "100";
    depthLayDraw = "100";
  }

  return {
    bookmaker: usedBookie,
    backOddsA,
    layOddsA,
    depthBackA,
    depthLayA,
    backOddsB,
    layOddsB,
    depthBackB,
    depthLayB,
    backOddsDraw,
    layOddsDraw,
    depthBackDraw,
    depthLayDraw,
    matchOddsDepth: {
      teamABack: homeDepth.backOdds,
      teamALay: homeDepth.layOdds,
      teamBBack: awayDepth.backOdds,
      teamBLay: awayDepth.layOdds,
      drawBack: isTest ? (drawDepth?.backOdds || (backOddsDraw ? [{ price: backOddsDraw, volume: depthBackDraw }] : [])) : [],
      drawLay: isTest ? (drawDepth?.layOdds || (layOddsDraw ? [{ price: layOddsDraw, volume: depthLayDraw }] : [])) : [],
    },
    isTestMatch: isTest,
  };
}

/**
 * 1-Day Completed Matches Cleanup Algorithm:
 * Purges completed/resulted matches older than 24 hours from MongoDB, MarketOdds,
 * OddsMarket, Redis caches, and Supabase `match_results`.
 */
async function cleanupCompletedMatches() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const thirtySixHoursAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);

    // Always sweep Supabase 24h archive in parallel
    await supabaseService.purgeExpiredMatchResults().catch(() => {});

    const staleQuery = {
      $and: [
        { status: { $ne: 'live' } },
        {
          $or: [
            { status: 'completed' },
            { status: 'resulted' },
            { winner: { $ne: null } },
            { isCompleted: true },
            { 'score.statusText': { $regex: /finished|completed|result/i } }
          ]
        },
        {
          $or: [
            { completedAt: { $ne: null, $lt: oneDayAgo } },
            {
              $and: [
                { $or: [{ completedAt: null }, { completedAt: { $exists: false } }] },
                {
                  $or: [
                    { lastUpdated: { $lt: oneDayAgo } },
                    { startTime: { $lt: thirtySixHoursAgo } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    };

    const staleMatches = await Match.find(staleQuery).select('matchId').lean();
    if (staleMatches.length === 0) return { deletedCount: 0 };

    const staleIds = staleMatches.map(m => m.matchId).filter(Boolean);

    const deleteRes = await Match.deleteMany({ matchId: { $in: staleIds } });
    await MarketOdds.deleteMany({ matchId: { $in: staleIds } }).catch(() => {});
    await OddsMarket.deleteMany({ dbMatchId: { $in: staleIds } }).catch(() => {});

    try {
      const redisCache = require('./upstashRedisCache');
      await redisCache.invalidateMatchCatalogs();
      for (const id of staleIds) {
        await redisCache.del(`bpx:odds:${id}`).catch(() => {});
        await redisCache.del(`bpx:score:${id}`).catch(() => {});
        await redisCache.del(`bpx:match:${id}`).catch(() => {});
      }
    } catch (rErr) {}

    console.log(`[MatchService] 🧹 1-Day Cleanup: Permanently deleted ${deleteRes.deletedCount} old completed match(es) from DB.`);
    return deleteRes;
  } catch (err) {
    console.error('[MatchService] ❌ Error in cleanupCompletedMatches:', err.message);
    return { deletedCount: 0 };
  }
}

/**
 * fetchUpcomingMatches
 *
 * Fetches real cricket fixtures from oddspapi REST API strictly for yesterday + today
 * (plus actively live events), removes SRL/virtuals, and prunes out-of-window future/old fixtures.
 */
const fetchUpcomingMatches = async (io) => {
  try {
    console.log("[MatchService] Syncing cricket fixtures (yesterday + today + live) from oddspapi...");

    // Run 1-day completed matches cleanup algorithm (MongoDB + Supabase)
    await cleanupCompletedMatches();

    // 1. Prune SRL/virtuals and any non-live, non-completed upcoming matches outside [yesterday .. today]
    const now = new Date();
    const { windowStartMs, windowEndMs, windowStartDate, windowEndDate } = getMatchScheduleWindow(now);

    await Match.deleteMany({
      $or: [
        { teamA: /srl/i },
        { teamB: /srl/i },
        { league: /srl/i },
        { sportKey: /srl/i },
      ],
    });

    const prunedWindowCount = await Match.deleteMany({
      status: 'upcoming',
      $or: [
        { startTime: { $lt: windowStartDate } },
        { startTime: { $gt: windowEndDate } },
      ],
    });

    if (prunedWindowCount.deletedCount > 0) {
      console.log(
        `[MatchService] 🗑️ Window Reset: Cleaned ${prunedWindowCount.deletedCount} out-of-window match(es) outside yesterday..today.`,
      );
    }

    // 2. Fetch fixtures ONLY for yesterday + today window and live fixtures
    const windowStartTs = Math.floor(windowStartMs / 1000);
    const windowEndTs = Math.floor(windowEndMs / 1000);

    const [upcomingFixtures, liveFixtures] = await Promise.all([
      getData("fixtures", {
        params: {
          startTimeFrom: windowStartTs,
          startTimeTo: windowEndTs,
        },
      }).catch(() => []),
      getData("fixtures/live").catch(() => []),
    ]);

    // Merge and deduplicate raw fixture objects by fixture ID
    const fixtureMap = new Map();
    for (const f of [...(liveFixtures || []), ...(upcomingFixtures || [])]) {
      const fId = f?.fixtureId || f?.id;
      if (fId && !fixtureMap.has(fId)) {
        fixtureMap.set(fId, f);
      }
    }
    const response = Array.from(fixtureMap.values());

    if (!response || response.length === 0) {
      console.warn("[MatchService] No fixtures returned or API error.");
      return;
    }

    console.log(
      `[MatchService] Total fixtures received from oddspapi: ${response.length}`,
    );

    // 3. Filter valid cricket fixtures and prioritize international
    const validCandidates = response.filter((f) => shouldIncludeFixture(f, now));

    // Sort: Priority DESC (International Tier 1 > Tier 2 > Tier 3), then startTime ASC
    validCandidates.sort((a, b) => {
      const prioA = getCricketPriority(a);
      const prioB = getCricketPriority(b);
      if (prioB !== prioA) return prioB - prioA;
      return (a.startTime || 0) - (b.startTime || 0);
    });

    console.log(
      `[MatchService] Filtered candidates: ${validCandidates.length}. Processing top matches...`,
    );

    // 4. Fetch odds for candidates (checking international & top T20 franchises like BBL/WBBL)
    const fixturePool = [];
    const maxFixturesToProcess = 120;

    for (const fixture of validCandidates) {
      const fixtureId = fixture.fixtureId || fixture.id;
      if (!fixtureId) continue;

      const isInternational = isInternationalFixture(fixture);
      const isMajorFranchise = typeof isTopFranchiseLeague === "function" && isTopFranchiseLeague(fixture);
      const isLive = Boolean(fixture.status?.live || fixture.status === "live");
      const startMs = (fixture.startTime || 0) * 1000;
      const isWithin72Hours = startMs <= Date.now() + 72 * 3600 * 1000;

      let oddsResponse = null;
      let parsedOdds = null;

      // Only call odds endpoint if match is live or starting within 72 hours
      // Pre-game matches 4-30 days out do not have open exchange odds yet
      if (isLive || isWithin72Hours || fixture.hasOdds) {
        try {
          oddsResponse = await getData("fixtures/odds", {
            params: { fixtureId, bookmakers: "betfair-ex,pinnacle" },
          });

          if (oddsResponse) {
            parsedOdds = extractMatchOdds(oddsResponse, fixture);
          }
        } catch (err) {
          console.warn(`[MatchService] Could not fetch odds for fixture ${fixtureId}:`, err.message);
        }
      }

      const hasOdds = Boolean(parsedOdds && (parsedOdds.backOddsA !== null || parsedOdds.backOddsB !== null));

      // For Tier 1/2 international matches and top franchise leagues (BBL/WBBL/IPL/etc.), include even if odds are pending
      // For other domestic matches, only include if they have active exchange odds
      if (!isInternational && !isMajorFranchise && !hasOdds) {
        continue;
      }

      fixturePool.push({
        ...fixture,
        oddsData: parsedOdds,
        hasOdds: hasOdds,
      });

      if (fixturePool.length >= maxFixturesToProcess) break;
    }

    // 5. Map fixtures to Match model format
    const topMatches = fixturePool.map((f) => {
      const odds = f.oddsData;
      const isTest = isTestMatchFormat(f);
      return {
        matchId: f.fixtureId || f.id,
        tournamentId: f.tournament?.tournamentId || null,
        teamA: f.participants?.participant1Name || f.home_team || "Team 1",
        teamB: f.participants?.participant2Name || f.away_team || "Team 2",
        league: f.tournament?.tournamentName || f.league || "Cricket",
        startTime: new Date((f.startTime || f.commence_time || 0) * 1000),
        status: f.status?.live
          ? "live"
          : f.status?.statusName === "Finished"
            ? "completed"
            : "upcoming",
        sportKey: isInternationalFixture(f)
          ? "cricket_international"
          : "cricket_domestic",
        backOddsA: odds ? odds.backOddsA : null,
        layOddsA: odds ? odds.layOddsA : null,
        depthBackA: odds ? odds.depthBackA : "0",
        depthLayA: odds ? odds.depthLayA : "0",
        backOddsB: odds ? odds.backOddsB : null,
        layOddsB: odds ? odds.layOddsB : null,
        depthBackB: odds ? odds.depthBackB : "0",
        depthLayB: odds ? odds.depthLayB : "0",
        backOddsDraw: isTest && odds ? odds.backOddsDraw : null,
        layOddsDraw: isTest && odds ? odds.layOddsDraw : null,
        depthBackDraw: isTest && odds ? odds.depthBackDraw : "0",
        depthLayDraw: isTest && odds ? odds.depthLayDraw : "0",
        isTestMatch: isTest,
        marketStatus: "OPEN",
        lastUpdated: new Date(),
      };
    });

    const activeIds = topMatches.map((m) => m.matchId);

    // 6. Upsert matches and MarketOdds into DB
    for (const m of topMatches) {
      // Check if match already exists with odds from OddsApiLiveService
      const existingMatch = await Match.findOne({ matchId: m.matchId }).lean();
      const existingHasOdds = existingMatch && existingMatch.backOddsA != null;
      const syncHasNoOdds = m.backOddsA == null;

      // If this sync has no odds but existing match DOES have odds (from OddsApiLiveService),
      // don't overwrite the odds/marketStatus — preserve what OddsApiLiveService set.
      if (syncHasNoOdds && existingHasOdds) {
        // Only update non-odds fields (teams, league, startTime, status, etc.)
        const patch = {
          teamA: m.teamA,
          teamB: m.teamB,
          league: m.league,
          startTime: m.startTime,
          status: m.status,
          sportKey: m.sportKey,
          isTestMatch: Boolean(m.isTestMatch),
          lastUpdated: m.lastUpdated,
        };
        if (!m.isTestMatch) {
          patch.backOddsDraw = null;
          patch.layOddsDraw = null;
          patch.depthBackDraw = "0";
          patch.depthLayDraw = "0";
          patch.bookmakerBackDraw = null;
          patch.bookmakerLayDraw = null;
        }
        await Match.findOneAndUpdate(
          { matchId: m.matchId },
          { $set: patch },
        );
      } else {
        await Match.findOneAndUpdate(
          { matchId: m.matchId },
          {
            $set: m,
            $setOnInsert: {
              score: {
                teamA_runs: "0/0",
                teamB_runs: "0/0",
                overs: "0.0",
                lastUpdated: new Date(),
              },
            },
          },
          { upsert: true, returnDocument: "after" },
        );
      }

      // Also upsert to MarketOdds if odds exist
      if (m.backOddsA !== null) {
        await MarketOdds.findOneAndUpdate(
          { matchId: m.matchId },
          {
            $set: {
              dbMatchId: m.matchId,
              teamA: m.teamA,
              teamB: m.teamB,
              teamABack: m.backOddsA,
              teamALay: m.layOddsA,
              teamBBack: m.backOddsB,
              teamBLay: m.layOddsB,
              marketStatus: "OPEN",
              isLive: m.status === "live",
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );
      }
    }

    // 7. Prune inactive matches outside the yesterday..today schedule window (preserve completed matches for 24h TTL)
    const staleLiveTime = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const deleteResult = await Match.deleteMany({
      matchId: { $nin: activeIds },
      $or: [
        { status: "upcoming", startTime: { $lt: windowStartDate } },
        { status: "upcoming", startTime: { $gt: windowEndDate } },
        { status: "completed", completedAt: { $lt: oneDayAgo } },
        { status: "completed", completedAt: null, lastUpdated: { $lt: oneDayAgo } },
        { status: "live", startTime: { $lt: staleLiveTime } },
      ],
    });

    if (deleteResult.deletedCount > 0) {
      console.log(
        `[MatchService] 🗑️ Pruned ${deleteResult.deletedCount} old or out-of-window matches.`,
      );
    }

    console.log(
      `[MatchService] ✅ Sync complete. Total synced matches: ${activeIds.length}`,
    );

    // Invalidate Redis match catalog cache & broadcast strictly active matches
    try {
      const { broadcastActiveCatalog } = require('./matchCatalogService');
      await broadcastActiveCatalog(io);
    } catch (rErr) {}
  } catch (error) {
    console.error("[MatchService] Error during sync:", error.message);
  }
};

module.exports = { fetchUpcomingMatches, extractMatchOdds, cleanupCompletedMatches };

