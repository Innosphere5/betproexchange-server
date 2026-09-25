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
];

const DOMESTIC_BLACKLIST_PATTERNS = [
  // Virtual / SRL / Cyber / Esports
  /\b(srl|simulated|virtual|cyber|esports|electronic)\b/i,
  // Youth / Under-19 / U23
  /\b(u19|u 19|under 19|under 19s|u23|under 23|youth)\b/i,
  // Legends / Veterans / Masters / Exhibition
  /\b(legends|championship of legends|road safety|veterans|masters)\b/i,
  // "A" teams / second-tier development / emerging
  /\b(india a|australia a|england lions|pakistan shaheens|south africa emerging|nigeria a|team a|new zealand a|west indies a)\b/i,
  // South African domestic leagues
  /\b(csa t20 challenge|csa 4 day|csa pro50|csa pro20|csa provincial)\b/i,
  // Australian domestic state cricket
  /\b(marsh one day|sheffield shield)\b/i,
  // USA / Regional minor leagues
  /\b(minor league|minor league cricket)\b/i,
  // Local African / Regional cups
  /\b(eswatini|t10 eswatini|eswatini cup|nigeria quadrangular|quadrangular|north american cup)\b/i,
  // Minor local Indian State T20 leagues
  /\b(odisha pro t20|uttarakhand premier league|andhra premier league|pondicherry|bengal pro|tamil nadu premier|tnpl|maharaja trophy|kpl|delhi premier league|dpl|up t20|baroda premier|saurashtra premier|mumbai t20)\b/i,
  // European T10 / amateur
  /\b(european cricket|ecs|ecl|t10 european)\b/i,
  // Club / invitational cricket
  /\b(cricket club|club xi|county championship|second xi|2nd xi)\b/i,
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
  return isTargetBPExchFixture(fixture);
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
  const liveBonus = isLive ? 300 : 0;

  const p1IsT1 = isTier1NationalTeam(p1);
  const p2IsT1 = isTier1NationalTeam(p2);

  // Tier 1: Top International bilateral/ICC between Tier 1 nations (ENG vs SL, AUS vs SA, IND vs PAK)
  if (p1IsT1 && p2IsT1) {
    return liveBonus + 800;
  }

  // Tier 1b: One Tier 1 nation playing against an associate in international series
  if (p1IsT1 || p2IsT1) {
    return liveBonus + 700;
  }

  // Tier 2: Premier franchise league (IPL, PSL, BBL)
  for (const league of TIER1_FRANCHISE_LEAGUES) {
    if (tName.includes(league)) {
      return liveBonus + 600;
    }
  }

  // Tier 3: Other official ICC tournaments (CWC League 2)
  return liveBonus + 400;
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
    // Allow up to 7 days in advance for international cricket matches
    const maxWindowMs = 7 * 24 * 60 * 60 * 1000;
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
  isTargetBPExchFixture,
  isVirtualOrSimulated,
};
