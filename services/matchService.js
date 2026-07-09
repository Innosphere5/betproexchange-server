const Match = require("../models/Match");
const { getData } = require("./apiManager");
const { shouldIncludeFixture, selectDisplayableFixtures } = require("./fixtureFilter");

/**
 * fetchUpcomingMatches
 *
 * Migrated to oddspapi REST API (v5.oddspapi.io).
 * Fetches cricket fixtures for today and the next 7 days.
 * Maps oddspapi fixture structure to the Match model.
 */
const fetchUpcomingMatches = async (io) => {
  try {
    console.log("[MatchService] Syncing fixtures from oddspapi...");

    // 1. Midnight Reset: Remove all matches from previous days (except LIVE)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

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
    const twoDaysLater = nowTs + 2 * 24 * 3600;

    const response = await getData("fixtures", {
      params: {
        startTimeFrom: nowTs,
        startTimeTo: twoDaysLater,
      },
    });

    if (!response || !Array.isArray(response) || response.length === 0) {
      console.warn("[MatchService] No fixtures returned or API error.");
      return;
    }

    console.log(
      `[MatchService] Total fixtures from oddspapi: ${response.length}`,
    );
    if (response.length > 0) {
      console.log(
        `[MatchService] Sample Data (First 3):`,
        response.slice(0, 3).map((f) => ({
          id: f.fixtureId,
          tournament: f.tournament?.tournamentName,
          status: f.status?.statusName,
        })),
      );
    }

    const fixturePool = [];
    for (const fixture of response) {
      if (!shouldIncludeFixture(fixture, now)) continue;

      const fixtureId = fixture.fixtureId || fixture.id;
      if (!fixtureId) continue;

      const oddsResponse = await getData("fixtures/odds", {
        params: { fixtureId },
      });

      const hasOdds = Boolean(oddsResponse && (Array.isArray(oddsResponse) ? oddsResponse.length > 0 : Object.keys(oddsResponse).length > 0));
      if (!hasOdds) continue;

      fixturePool.push({ ...fixture, hasOdds: true });
      if (fixturePool.length >= 7) break;
    }

    const displayFixtures = selectDisplayableFixtures(fixturePool, {
      now,
      limit: 7,
      requireOdds: true,
    });

    // 3. Map oddspapi fixtures to our Match model format
    let matches = displayFixtures.map((f) => ({
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
      sportKey: "cricket_international",
      lastUpdated: new Date(),
    }));

    // 4. Sort and Store
    const upcomingOrLive = matches.filter((m) => m.status !== "completed");
    upcomingOrLive.sort((a, b) => a.startTime - b.startTime);

    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const todayMatches = upcomingOrLive.filter((m) => m.startTime < todayEnd);
    const futureMatches = upcomingOrLive
      .filter((m) => m.startTime >= todayEnd)
      .slice(0, 30);

    const topMatches = [...todayMatches, ...futureMatches];
    const activeIds = topMatches.map((m) => m.matchId);

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
    }

    // 5. Final Pruning
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
      `[MatchService] ✅ Sync complete. Top Matches: ${activeIds.length}`,
    );

    if (io) {
      const allMatches = await Match.find().sort({ startTime: 1 });
      io.emit("matches_updated", allMatches);
    }
  } catch (error) {
    console.error("[MatchService] Error during sync:", error.message);
  }
};

module.exports = { fetchUpcomingMatches };
