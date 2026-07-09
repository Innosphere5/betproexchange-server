function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFixtureStartTimeMs(fixture) {
  const rawStart = fixture?.startTime;
  if (rawStart === undefined || rawStart === null || rawStart === "") return null;

  const parsed = Number(rawStart);
  if (!Number.isFinite(parsed)) return null;

  return parsed > 1e12 ? parsed : parsed * 1000;
}

function hasOddsMarket(fixture) {
  if (fixture?.hasOdds === true) return true;

  const oddsCandidate = fixture?.oddsData || fixture?.odds || fixture?.markets;
  if (!oddsCandidate) {
    const hasBasicOdds = [
      fixture?.backOddsA,
      fixture?.layOddsA,
      fixture?.backOddsB,
      fixture?.layOddsB,
    ].some((value) => value !== null && value !== undefined && value !== "");
    return hasBasicOdds;
  }

  const items = Array.isArray(oddsCandidate) ? oddsCandidate : [oddsCandidate];
  return items.some((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.bookmakers || item.bookmaker || item.markets) return true;

    const nestedValues = Object.values(item);
    return nestedValues.some((value) => {
      if (!value || typeof value !== "object") return false;
      return Boolean(value.bookmaker || value.markets || value.odds || value.outcomes);
    });
  });
}

function isCricketFixture(fixture) {
  const sportName = normalizeText(
    fixture?.sport?.sportName || fixture?.sport_key || fixture?.sport || "",
  );
  if (sportName.includes("cricket")) return true;
  if (sportName.includes("football") || sportName.includes("soccer"))
    return false;

  const tournamentName = normalizeText(
    fixture?.tournament?.tournamentName ||
      fixture?.league ||
      fixture?.tournament ||
      "",
  );
  if (tournamentName.includes("cricket")) return true;

  const participantsText = normalizeText(
    [
      fixture?.participants?.participant1Name,
      fixture?.participants?.participant2Name,
      fixture?.home_team,
      fixture?.away_team,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (participantsText.includes("cricket")) return true;

  const combinedText = `${tournamentName} ${participantsText}`;
  return /\b(t20|t20i|twenty20|twenty20 international|odi|one day international|one-day international|test|test match)\b/.test(
    combinedText,
  );
}

function shouldIncludeFixture(fixture, now = new Date()) {
  if (!fixture) return false;

  if (!isCricketFixture(fixture)) return false;

  const startTimeMs = getFixtureStartTimeMs(fixture);
  if (startTimeMs !== null) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const isLiveFixture = Boolean(
      fixture?.status?.live ||
        /live|in play|in-play|paused|delayed/i.test(
          normalizeText(
            fixture?.status?.statusName || fixture?.status?.shortName || "",
          ),
        ),
    );

    const isWithinWindow = startTimeMs >= nowMs && startTimeMs <= nowMs + twoDaysMs;
    if (!isWithinWindow && !isLiveFixture) return false;
  }

  const tournamentName = normalizeText(
    fixture?.tournament?.tournamentName ||
      fixture?.league ||
      fixture?.tournament ||
      "",
  );
  const participantText = normalizeText(
    [
      fixture?.participants?.participant1Name,
      fixture?.participants?.participant2Name,
      fixture?.home_team,
      fixture?.away_team,
    ]
      .filter(Boolean)
      .join(" "),
  );

  const combinedText = `${tournamentName} ${participantText}`;

  const cricketCueRegex =
    /\b(cricket|t20|t20i|twenty20|twenty20 international|odi|one day international|one-day international|test|test match|icc|world cup|world championship|series|tri series|champions trophy|asia cup|qualifier)\b/;
  const matchTypeRegex =
    /\b(t20|t20i|twenty20|twenty20 international|odi|one day international|one-day international|test|test match)\b/;
  const internationalRegex =
    /\b(international|world cup|world championship|series|tri series|champions trophy|asia cup|icc|qualifier|trophy)\b/;
  const domesticRegex =
    /\b(ipl|indian premier league|psl|big bash|cpl|bbl|t20 blast|county championship|sheffield shield|domestic|league|one day cup|list a|first class|plunket shield|ranji|victoria|caribbean premier league|major league cricket|mcl|super league|premier league|national league|men's domestic|women's super league|wsl)\b/;

  const hasCricketCue = cricketCueRegex.test(combinedText);
  const hasMatchType = matchTypeRegex.test(combinedText);
  if (!hasCricketCue || !hasMatchType) return false;

  const hasDomesticIndicator = domesticRegex.test(combinedText);
  const hasInternationalIndicator = internationalRegex.test(combinedText);

  if (hasDomesticIndicator && !hasInternationalIndicator) return false;

  return true;
}

function selectDisplayableFixtures(fixtures, options = {}) {
  const now = options.now || new Date();
  const limit = options.limit || 7;
  const requireOdds = options.requireOdds !== false;

  const selected = [];
  for (const fixture of fixtures || []) {
    if (!shouldIncludeFixture(fixture, now)) continue;
    if (requireOdds && !hasOddsMarket(fixture)) continue;

    selected.push(fixture);
    if (selected.length >= limit) break;
  }

  return selected;
}

module.exports = {
  shouldIncludeFixture,
  normalizeText,
  hasOddsMarket,
  selectDisplayableFixtures,
};
