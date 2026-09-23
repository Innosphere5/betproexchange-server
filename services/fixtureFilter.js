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

const TIER1_TEAMS = new Set([
  "india", "australia", "england", "south africa", "pakistan",
  "new zealand", "sri lanka", "west indies", "bangladesh",
  "afghanistan", "zimbabwe", "ireland"
]);

const TIER2_TEAMS = new Set([
  "netherlands", "scotland", "namibia", "nepal", "oman",
  "united arab emirates", "uae", "canada", "usa", "united states",
  "uganda", "papua new guinea", "png", "hong kong", "hong kong china",
  "kenya", "italy", "jersey", "kuwait", "qatar", "saudi arabia",
  "singapore", "malaysia", "nigeria", "bermuda", "bahamas", "cayman",
  "tanzania", "rwanda", "ghana", "sierra leone", "bhutan", "maldives",
  "japan", "fiji", "vanuatu", "samoa", "indonesia", "philippines"
]);

function isVirtualOrSimulated(fixture) {
  const combined = normalizeText([
    fixture?.tournament?.tournamentName,
    fixture?.participants?.participant1Name,
    fixture?.participants?.participant2Name,
    fixture?.league,
    fixture?.home_team,
    fixture?.away_team,
    fixture?.teamA,
    fixture?.teamB,
    fixture?.sportKey,
  ].join(" "));

  return /\b(srl|simulated|virtual|electronic|esports|cyber)\b/.test(combined);
}

function isCricketFixture(fixture) {
  if (isVirtualOrSimulated(fixture)) return false;

  const sportName = normalizeText(
    fixture?.sport?.sportName || fixture?.sport_key || fixture?.sport || "",
  );
  if (sportName.includes("cricket")) return true;
  if (sportName.includes("football") || sportName.includes("soccer") || sportName.includes("tennis") || sportName.includes("basketball"))
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
      fixture?.teamA,
      fixture?.teamB,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (participantsText.includes("cricket")) return true;

  const combinedText = `${tournamentName} ${participantsText}`;
  return /\b(cricket|t20|t20i|twenty20|twenty20 international|odi|one day international|one-day international|test|test match|icc|world cup|champions trophy|asia cup)\b/.test(
    combinedText,
  );
}

function getCricketPriority(fixture) {
  if (isVirtualOrSimulated(fixture)) return -1;

  const tName = normalizeText(fixture?.tournament?.tournamentName || fixture?.league || "");
  const p1 = normalizeText(fixture?.participants?.participant1Name || fixture?.home_team || fixture?.teamA || "");
  const p2 = normalizeText(fixture?.participants?.participant2Name || fixture?.away_team || fixture?.teamB || "");
  const combined = `${tName} ${p1} ${p2}`;

  const isT1Team1 = Array.from(TIER1_TEAMS).some((t) => p1.includes(t));
  const isT1Team2 = Array.from(TIER1_TEAMS).some((t) => p2.includes(t));
  const isT2Team1 = Array.from(TIER2_TEAMS).some((t) => p1.includes(t));
  const isT2Team2 = Array.from(TIER2_TEAMS).some((t) => p2.includes(t));

  const isBilateralOrICC = /\b(odi series|test series|t20i series|t20 series|world cup|asia cup|champions trophy|icc|tri series|bilateral)\b/.test(tName);
  const isLive = Boolean(
    fixture?.status?.live ||
    fixture?.status === "live" ||
    /live|in play|in-play/i.test(normalizeText(fixture?.status?.statusName || fixture?.status?.shortName || ""))
  );
  const liveBonus = isLive ? 200 : 0;

  // Tier 1: Both teams are Tier 1 (e.g., England vs Sri Lanka, South Africa vs Australia)
  if (isT1Team1 && isT1Team2) {
    return liveBonus + 100;
  }

  // Tier 1b: One Tier 1 team in an international series / ICC tournament
  if ((isT1Team1 || isT1Team2) && (isBilateralOrICC || /\b(international|series|icc|trophy)\b/.test(tName))) {
    return liveBonus + 90;
  }

  // Tier 2: Associate international matches (Asian Games, T20 World Cup Qualifier, etc.)
  if ((isT2Team1 || isT2Team2) && (isBilateralOrICC || /\b(asian games|qualifier|cup|quadrangular|challenge league|league two)\b/.test(tName))) {
    return liveBonus + 70;
  }

  // Tier 2b: Any tournament marked as international
  if (/\b(international|world cup|world championship|asia cup|champions trophy|icc)\b/.test(tName)) {
    return liveBonus + 60;
  }

  // Tier 3: Major domestic leagues with Betfair exchange liquidity
  if (/\b(county championship|ipl|indian premier league|big bash|bbl|psl|cpl|the hundred|marsh one day|super smash|csa t20 challenge)\b/.test(tName)) {
    return liveBonus + 40;
  }

  // Tier 4: Other domestic cricket
  return liveBonus + 10;
}

function isInternationalFixture(fixture) {
  const prio = getCricketPriority(fixture);
  // Tier 1 and Tier 2 fixtures have priority >= 60 (excluding live bonus)
  const basePrio = prio >= 200 ? prio - 200 : prio;
  return basePrio >= 60;
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

function shouldIncludeFixture(fixture, now = new Date()) {
  if (!fixture) return false;
  if (isVirtualOrSimulated(fixture)) return false;
  if (!isCricketFixture(fixture)) return false;

  const startTimeMs = getFixtureStartTimeMs(fixture);
  const isLive = Boolean(
    fixture?.status?.live ||
    fixture?.status === "live" ||
    /live|in play|in-play/i.test(normalizeText(fixture?.status?.statusName || fixture?.status?.shortName || ""))
  );

  if (startTimeMs !== null) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
    // Allow up to 7 days in advance for international and upcoming cricket matches
    const maxWindowMs = 7 * 24 * 60 * 60 * 1000;
    const isWithinWindow = startTimeMs >= (nowMs - 24 * 60 * 60 * 1000) && startTimeMs <= (nowMs + maxWindowMs);
    if (!isWithinWindow && !isLive) return false;
  }

  return true;
}

function selectDisplayableFixtures(fixtures, options = {}) {
  const now = options.now || new Date();
  const limit = options.limit || 30;
  const requireOdds = options.requireOdds === true;

  const valid = [];
  for (const fixture of fixtures || []) {
    if (!shouldIncludeFixture(fixture, now)) continue;
    if (requireOdds && !hasOddsMarket(fixture)) continue;
    valid.push(fixture);
  }

  // Prioritize international matches first, then start time
  valid.sort((a, b) => {
    const prioA = getCricketPriority(a);
    const prioB = getCricketPriority(b);
    if (prioB !== prioA) return prioB - prioA;

    const timeA = getFixtureStartTimeMs(a) || 0;
    const timeB = getFixtureStartTimeMs(b) || 0;
    return timeA - timeB;
  });

  return valid.slice(0, limit);
}

module.exports = {
  shouldIncludeFixture,
  normalizeText,
  hasOddsMarket,
  selectDisplayableFixtures,
  getCricketPriority,
  isInternationalFixture,
  isVirtualOrSimulated,
};

