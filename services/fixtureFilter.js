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
  if (rawStart instanceof Date) return rawStart.getTime();

  const parsed = Number(rawStart);
  if (!Number.isFinite(parsed)) return null;

  return parsed > 1e12 ? parsed : parsed * 1000;
}

const TIER1_TEAMS = new Set([
  "india",
  "australia",
  "england",
  "south africa",
  "pakistan",
  "new zealand",
  "sri lanka",
  "west indies",
  "bangladesh",
  "afghanistan",
  "zimbabwe",
  "ireland",
]);

const TIER2_TEAMS = new Set([
  "netherlands",
  "scotland",
  "namibia",
  "nepal",
  "oman",
  "united arab emirates",
  "uae",
  "canada",
  "usa",
  "united states",
]);

const TIER1_FRANCHISE_LEAGUES = [
  "indian premier league",
  "ipl",
  "pakistan super league",
  "psl",
  "big bash league",
  "bbl",
  "caribbean premier league",
  "cpl",
  "the hundred",
  "sa20",
  "ilt20",
  "major league cricket",
  "mlc",
  "womens premier league",
  "wpl",
  "t20 south africa cup",
  "south africa cup",
  "csa",
  "one-day cup",
  "sheffield shield",
  "super smash",
  "vitality blast",
  "t20 blast",
];

const DOMESTIC_BLACKLIST_PATTERNS = [
  // Virtual / SRL / Cyber / Esports
  /\b(srl|simulated|virtual|cyber|esports|electronic)\b/i,
  // Youth / Under-19 / U23
  /\b(u19|u 19|under 19|under 19s|u23|under 23|youth)\b/i,
  // Legends / Veterans / Masters / Exhibition
  /\b(legends|championship of legends|road safety|veterans|masters)\b/i,
  // European T10 amateur / club
  /\b(european cricket|ecs|ecl|t10 european)\b/i,
  // Minor local club cricket
  /\b(cricket club|club xi)\b/i,
];

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

function cleanTeamName(name) {
  const normalized = normalizeText(name);
  return normalized
    .replace(/\b(women|men|xi|national|team)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNationalTeam(teamStr) {
  const cleaned = cleanTeamName(teamStr);
  return TIER1_TEAMS.has(cleaned) || TIER2_TEAMS.has(cleaned);
}

function isTier1NationalTeam(teamStr) {
  const cleaned = cleanTeamName(teamStr);
  return TIER1_TEAMS.has(cleaned);
}

function isCricketFixture(fixture) {
  if (isVirtualOrSimulated(fixture)) return false;

  const sportName = normalizeText(
    fixture?.sport?.sportName || fixture?.sport_key || fixture?.sport || fixture?.sportKey || "",
  );
  if (sportName.includes("cricket")) return true;
  if (
    sportName.includes("football") ||
    sportName.includes("soccer") ||
    sportName.includes("tennis") ||
    sportName.includes("basketball")
  ) {
    return false;
  }

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

/**
 * Validates whether a fixture matches the standards of BPExch (bpexch.live):
 * - International ODI, T20I, Test matches between recognised national teams (AUS, IND, PAK, SL, ENG, SA, NZ, etc.)
 * - Major international tournaments (ICC World Cup, Champions Trophy, Asia Cup, CWC League 2)
 * - Top-tier franchise leagues (IPL, PSL, BBL, CPL, etc.)
 * - Rejects all minor/domestic/tournament-level state cricket
 */
function isTargetBPExchFixture(fixture) {
  if (!fixture) return false;
  if (isVirtualOrSimulated(fixture)) return false;

  const tName = normalizeText(
    fixture?.tournament?.tournamentName || fixture?.league || fixture?.tournament || "",
  );
  const p1 = normalizeText(
    fixture?.participants?.participant1Name || fixture?.home_team || fixture?.teamA || "",
  );
  const p2 = normalizeText(
    fixture?.participants?.participant2Name || fixture?.away_team || fixture?.teamB || "",
  );
  const sport = normalizeText(
    fixture?.sport?.sportName || fixture?.sport || fixture?.sportKey || "",
  );

  const combined = `${tName} ${p1} ${p2} ${sport}`;

  // 1. Strict blacklist check
  for (const pattern of DOMESTIC_BLACKLIST_PATTERNS) {
    if (pattern.test(combined)) {
      return false;
    }
  }

  // 2. Tier 1 Franchise Leagues check (IPL, PSL, BBL, etc.)
  for (const league of TIER1_FRANCHISE_LEAGUES) {
    if (tName.includes(league)) {
      return true;
    }
  }

  // 3. International Series / Tournaments
  const isInternationalSeries =
    /\b(odi series|t20i series|t20 series|test series|world cup|asia cup|champions trophy|icc|international|bilateral|tri series|tour of)\b/i.test(
      tName,
    );

  const p1IsT1 = isTier1NationalTeam(p1);
  const p2IsT1 = isTier1NationalTeam(p2);
  const p1IsNat = isNationalTeam(p1);
  const p2IsNat = isNationalTeam(p2);

  // Both teams are Tier 1 Full Members (e.g. England vs Sri Lanka, South Africa vs Australia)
  if (p1IsT1 && p2IsT1) {
    return true;
  }

  // One team is Tier 1 and other is a national team (e.g. India vs Netherlands, Australia vs Scotland)
  if ((p1IsT1 || p2IsT1) && (p1IsNat && p2IsNat)) {
    return true;
  }

  // Both are national teams in an official ICC / international series (e.g. CWC League Two)
  if (isInternationalSeries && p1IsNat && p2IsNat) {
    return true;
  }

  // If tournament is an official ICC tournament involving national teams
  if (
    /\b(icc cricket world cup|icc men s t20 world cup|champions trophy|asia cup)\b/i.test(
      tName,
    ) &&
    p1IsNat &&
    p2IsNat
  ) {
    return true;
  }

  return false;
}

function isInternationalFixture(fixture) {
  if (!fixture) return false;
  const p1 = normalizeText(
    fixture?.participants?.participant1Name || fixture?.home_team || fixture?.teamA || "",
  );
  const p2 = normalizeText(
    fixture?.participants?.participant2Name || fixture?.away_team || fixture?.teamB || "",
  );
  const tName = normalizeText(
    fixture?.tournament?.tournamentName || fixture?.league || fixture?.tournament || "",
  );
  return (
    isNationalTeam(p1) ||
    isNationalTeam(p2) ||
    /\b(odi|t20i|test series|tri series|world cup|champions trophy|asia cup|icc)\b/i.test(tName)
  );
}

function isPakistanOrIndia(teamStr) {
  const cleaned = cleanTeamName(teamStr);
  return cleaned === "pakistan" || cleaned === "india";
}

function getFormatBonus(tName) {
  if (/\b(odi|one day|one-day)\b/i.test(tName)) return 300;
  if (/\b(t20|t20i|twenty20)\b/i.test(tName)) return 250;
  if (/\b(test|test match)\b/i.test(tName)) return 200;
  return 100;
}

function getCricketPriority(fixture) {
  if (!isTargetBPExchFixture(fixture)) return -1;

  const tName = normalizeText(
    fixture?.tournament?.tournamentName || fixture?.league || "",
  );
  const p1 = normalizeText(
    fixture?.participants?.participant1Name || fixture?.home_team || fixture?.teamA || "",
  );
  const p2 = normalizeText(
    fixture?.participants?.participant2Name || fixture?.away_team || fixture?.teamB || "",
  );

  const isLive = Boolean(
    fixture?.status?.live ||
      fixture?.status === "live" ||
      /live|in play|in-play/i.test(
        normalizeText(
          fixture?.status?.statusName || fixture?.status?.shortName || "",
        ),
      ),
  );
  const isCompleted = Boolean(
    fixture?.status === "completed" ||
      /finished|completed|ended/i.test(
        normalizeText(
          fixture?.status?.statusName || fixture?.status?.shortName || "",
        ),
      ),
  );

  // Live matches have absolute top priority (+20000)
  // Completed matches have penalty (-5000) so they sit at the bottom
  if (isLive) return 20000;
  if (isCompleted) return -5000;

  let prio = 0;
  const p1IsPakInd = isPakistanOrIndia(p1);
  const p2IsPakInd = isPakistanOrIndia(p2);
  const p1IsT1 = isTier1NationalTeam(p1);
  const p2IsT1 = isTier1NationalTeam(p2);

  // Tier 1: Top International featuring Pakistan or India (e.g. PAK vs ENG, PAK vs SL, IND vs NZ)
  if ((p1IsPakInd || p2IsPakInd) && p1IsT1 && p2IsT1) {
    prio += 3000;
  } else if (p1IsPakInd || p2IsPakInd) {
    // Pakistan or India vs other nation (e.g. IND vs ZIM)
    prio += 2400;
  } else if (p1IsT1 && p2IsT1) {
    // Other Tier 1 bilateral (e.g. AUS vs ENG, SA vs AUS, ENG vs SL)
    prio += 2000;
  } else if (p1IsT1 || p2IsT1) {
    // Tier 1 vs Tier 2 Associate (e.g. NAM vs IRE)
    prio += 1500;
  } else {
    // Tier 2 Franchise / other ICC (IPL, PSL, BBL, CWC League 2)
    prio += 1000;
  }

  // International format priority: ODI (+300) > T20/T20I (+250) > Test (+200)
  prio += getFormatBonus(tName);

  // Time-window urgency bonus (matches happening in next 48h to 7 days get priority boost)
  const startTimeMs = getFixtureStartTimeMs(fixture);
  if (startTimeMs) {
    const diffHours = (startTimeMs - Date.now()) / (3600 * 1000);
    if (diffHours >= 0 && diffHours <= 48) {
      prio += 500;
    } else if (diffHours > 48 && diffHours <= 168) {
      prio += 300;
    } else if (diffHours > 168 && diffHours <= 336) {
      prio += 100;
    }
  }

  return prio;
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
  if (!isCricketFixture(fixture)) return false;
  if (!isTargetBPExchFixture(fixture)) return false;

  const startTimeMs = getFixtureStartTimeMs(fixture);
  const isLive = Boolean(
    fixture?.status?.live ||
      fixture?.status === "live" ||
      /live|in play|in-play/i.test(
        normalizeText(
          fixture?.status?.statusName || fixture?.status?.shortName || "",
        ),
      ),
  );

  if (startTimeMs !== null) {
    const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
    // Allow up to 30 days in advance for international cricket matches (bilateral tours, series, ICC events)
    // and up to 7 days for franchise leagues
    const isInternational = isInternationalFixture(fixture);
    const maxWindowMs = isInternational
      ? 30 * 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
    const isWithinWindow =
      startTimeMs >= nowMs - 24 * 60 * 60 * 1000 &&
      startTimeMs <= nowMs + maxWindowMs;
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
  isPakistanOrIndia,
  isTargetBPExchFixture,
  isVirtualOrSimulated,
};
