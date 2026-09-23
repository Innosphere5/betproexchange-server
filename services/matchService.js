const Match = require("../models/Match");
const MarketOdds = require("../models/MarketOdds");
const { getData } = require("./apiManager");
const {
  shouldIncludeFixture,
  selectDisplayableFixtures,
  getCricketPriority,
  isInternationalFixture,
  isVirtualOrSimulated,
} = require("./fixtureFilter");

/**
 * Extracts Match Odds (h2h / winner) from oddspapi odds response.
 * Prefers Betfair Exchange quotes with full back/lay market depth.
 */
function extractMatchOdds(oddsResponse) {
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

  // Find Match Odds market (market with 2 outcomes, prioritizing mainLine)
  let winnerMarket = null;
  for (const [mId, grp] of Object.entries(byMarket)) {
    if (grp.length === 2 && grp.some((q) => q.mainLine === true)) {
      winnerMarket = grp;
      break;
    }
  }

  if (!winnerMarket) {
    for (const [mId, grp] of Object.entries(byMarket)) {
      if (grp.length === 2) {
        winnerMarket = grp;
        break;
      }
    }
  }

  if (!winnerMarket || winnerMarket.length < 2) return null;

  winnerMarket.sort(
    (a, b) => (Number(a.outcomeId) || 0) - (Number(b.outcomeId) || 0),
  );

  const homeQ = winnerMarket[0];
  const awayQ = winnerMarket[1];

  let backOddsA = null,
    layOddsA = null,
    depthBackA = "0",
    depthLayA = "0";
  let backOddsB = null,
    layOddsB = null,
    depthBackB = "0",
    depthLayB = "0";

  if (isExchange) {
    if (homeQ.meta) {
      backOddsA = homeQ.meta.availableToBack?.[0]?.price || homeQ.price || null;
      depthBackA = homeQ.meta.availableToBack?.[0]?.size
        ? Math.round(homeQ.meta.availableToBack[0].size).toString()
        : "0";
      layOddsA =
        homeQ.meta.availableToLay?.[0]?.price ||
        (backOddsA ? Number((backOddsA + 0.02).toFixed(2)) : null);
      depthLayA = homeQ.meta.availableToLay?.[0]?.size
        ? Math.round(homeQ.meta.availableToLay[0].size).toString()
        : "0";
    } else {
      backOddsA = homeQ.price;
      layOddsA = Number((homeQ.price + 0.01).toFixed(2));
    }

    if (awayQ.meta) {
      backOddsB = awayQ.meta.availableToBack?.[0]?.price || awayQ.price || null;
      depthBackB = awayQ.meta.availableToBack?.[0]?.size
        ? Math.round(awayQ.meta.availableToBack[0].size).toString()
        : "0";
      layOddsB =
        awayQ.meta.availableToLay?.[0]?.price ||
        (backOddsB ? Number((backOddsB + 0.02).toFixed(2)) : null);
      depthLayB = awayQ.meta.availableToLay?.[0]?.size
        ? Math.round(awayQ.meta.availableToLay[0].size).toString()
        : "0";
    } else {
      backOddsB = awayQ.price;
      layOddsB = Number((awayQ.price + 0.01).toFixed(2));
    }
  } else {
    backOddsA = homeQ.price;
    layOddsA = Number((homeQ.price + 0.01).toFixed(2));
    depthBackA = homeQ.limit ? Math.round(homeQ.limit).toString() : "500";
    depthLayA = "500";

    backOddsB = awayQ.price;
    layOddsB = Number((awayQ.price + 0.01).toFixed(2));
    depthBackB = awayQ.limit ? Math.round(awayQ.limit).toString() : "500";
    depthLayB = "500";
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
  };
}

/**
 * fetchUpcomingMatches
 *
 * Fetches cricket fixtures from oddspapi REST API for the next 7 days.
 * Strictly prioritizes real international cricket matches over domestic leagues.
 * Removes simulated reality leagues (SRL) and maps live & upcoming matches to DB.
 */
const fetchUpcomingMatches = async (io) => {
  try {
    console.log("[MatchService] Syncing cricket fixtures with international priority from oddspapi...");

    // 1. Clean previous matches from previous days (except LIVE) and purge any virtual/SRL matches
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    await Match.deleteMany({
      $or: [
        { teamA: /srl/i },
        { teamB: /srl/i },
        { league: /srl/i },
        { sportKey: /srl/i },
      ],
    });

    const prunedOldCount = await Match.deleteMany({
      startTime: { $lt: todayStart },
      status: { $ne: "live" },
    });

    if (prunedOldCount.deletedCount > 0) {
      console.log(
        `[MatchService] 🗑️ Midnight Reset: Cleaned ${prunedOldCount.deletedCount} previous matches.`,
      );
    }

    // 2. Fetch upcoming fixtures from oddspapi (next 7 days)
    const now = new Date();
    const nowTs = Math.floor(now.getTime() / 1000);
    const sevenDaysLater = nowTs + 7 * 24 * 3600;

    const response = await getData("fixtures", {
      params: {
        startTimeFrom: nowTs,
        startTimeTo: sevenDaysLater,
      },
    });

    if (!response || !Array.isArray(response) || response.length === 0) {
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

    // 4. Fetch odds for candidates (checking international fixtures first)
    const fixturePool = [];
    const maxFixturesToProcess = 30;

    for (const fixture of validCandidates) {
      const fixtureId = fixture.fixtureId || fixture.id;
      if (!fixtureId) continue;

      const isInternational = isInternationalFixture(fixture);
      let oddsResponse = null;
      let parsedOdds = null;

      try {
        oddsResponse = await getData("fixtures/odds", {
          params: { fixtureId },
        });

        if (oddsResponse) {
          parsedOdds = extractMatchOdds(oddsResponse);
        }
      } catch (err) {
        console.warn(`[MatchService] Could not fetch odds for fixture ${fixtureId}:`, err.message);
      }

      const hasOdds = Boolean(parsedOdds && (parsedOdds.backOddsA !== null || parsedOdds.backOddsB !== null));

      // For Tier 1 and Tier 2 international matches, include even if odds are pending
      // For domestic matches, only include if they have active exchange odds
      if (!isInternational && !hasOdds) {
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
        marketStatus: odds ? "OPEN" : "SUSPENDED",
        lastUpdated: new Date(),
      };
    });

    const activeIds = topMatches.map((m) => m.matchId);

    // 6. Upsert matches and MarketOdds into DB
    for (const m of topMatches) {
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

    // 7. Prune stale completed or obsolete matches
    const staleLiveTime = new Date(Date.now() - 12 * 60 * 60 * 1000);

    const deleteResult = await Match.deleteMany({
      matchId: { $nin: activeIds },
      $or: [
        { startTime: { $lt: todayStart } },
        { status: "completed" },
        { status: "live", startTime: { $lt: staleLiveTime } },
      ],
    });

    if (deleteResult.deletedCount > 0) {
      console.log(
        `[MatchService] 🗑️ Pruned ${deleteResult.deletedCount} old or inactive matches.`,
      );
    }

    console.log(
      `[MatchService] ✅ Sync complete. Total synced matches: ${activeIds.length}`,
    );

    if (io) {
      const allMatches = await Match.find().sort({ startTime: 1 });
      io.emit("matches_updated", allMatches);
    }
  } catch (error) {
    console.error("[MatchService] Error during sync:", error.message);
  }
};

module.exports = { fetchUpcomingMatches, extractMatchOdds };

