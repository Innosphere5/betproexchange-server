const https = require('https');
const API_KEY = '47867a6c1b58b5b0c53fdf6fe4fed924';

function fetchUrl(u) {
  return new Promise((resolve, reject) => {
    https.get(u, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(d); }
      });
    }).on('error', reject);
  });
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TIER1_NATIONS = [
  'australia', 'india', 'pakistan', 'sri lanka', 'england',
  'south africa', 'new zealand', 'west indies', 'bangladesh',
  'afghanistan', 'zimbabwe', 'ireland'
];

const TIER2_NATIONS = [
  'netherlands', 'scotland', 'nepal', 'oman', 'namibia',
  'united arab emirates', 'uae', 'canada', 'usa', 'united states'
];

const TIER1_LEAGUES = [
  'ipl', 'indian premier league',
  'psl', 'pakistan super league',
  'bbl', 'big bash league',
  'cpl', 'caribbean premier league',
  'the hundred',
  'sa20',
  'ilt20',
  'major league cricket', 'mlc',
  'wpl', 'women s premier league', 'womens premier league'
];

const DOMESTIC_BLACKLIST_PATTERNS = [
  // Virtual / SRL
  /\b(srl|simulated|virtual|cyber|esports|electronic)\b/i,
  // Youth / Under-19
  /\b(u19|u 19|under 19|under 19s|u23|under 23|youth)\b/i,
  // Legends / Veterans
  /\b(legends|championship of legends|road safety|veterans|masters)\b/i,
  // "A" teams / second string / emerging
  /\b(india a|australia a|england lions|pakistan shaheens|south africa emerging|nigeria a|team a|new zealand a|west indies a)\b/i,
  // Minor / state / provincial / local leagues
  /\b(csa t20 challenge|csa 4 day|csa pro50|csa pro20|csa provincial)\b/i,
  /\b(marsh one day|sheffield shield)\b/i,
  /\b(minor league|minor league cricket)\b/i,
  /\b(eswatini|t10 eswatini|eswatini cup)\b/i,
  /\b(quadrangular|nigeria quadrangular)\b/i,
  /\b(north american cup)\b/i,
  /\b(odisha pro t20|uttarakhand premier league|andhra premier league|pondicherry|bengal pro|tamil nadu premier|tnpl|maharaja trophy|kpl|delhi premier league|dpl|up t20|baroda premier|saurashtra premier)\b/i,
  /\b(european cricket|ecs|ecl|t10 european)\b/i,
  /\b(cricket club|cc|club xi)\b/i,
  /\b(county championship|second xi|2nd xi)\b/i
];

function isMatchForBPExch(fixture) {
  if (!fixture) return false;

  const tName = normalize(fixture?.tournament?.tournamentName || fixture?.league || '');
  const p1 = normalize(fixture?.participants?.participant1Name || fixture?.home_team || fixture?.teamA || '');
  const p2 = normalize(fixture?.participants?.participant2Name || fixture?.away_team || fixture?.teamB || '');
  const sport = normalize(fixture?.sport?.sportName || fixture?.sport || '');

  const combined = `${tName} ${p1} ${p2} ${sport}`;

  // 1. Strict blacklist
  for (const pattern of DOMESTIC_BLACKLIST_PATTERNS) {
    if (pattern.test(combined)) {
      return false;
    }
  }

  // 2. Check if it's one of the top franchise leagues (IPL, PSL, BBL, etc.)
  for (const league of TIER1_LEAGUES) {
    if (tName.includes(league)) {
      return true;
    }
  }

  // 3. International Cricket Check:
  // Is this an international tournament/series?
  const isInternationalSeries = /\b(odi series|t20i series|t20 series|test series|world cup|asia cup|champions trophy|icc|international|bilateral|tri series|tour of)\b/i.test(tName);

  // Helper to check if a team name represents a national team
  const isNationalTeam = (teamStr) => {
    // Strip common suffixes: women, men, xi
    const cleaned = teamStr.replace(/\b(women|men|xi|national)\b/g, '').trim();
    return TIER1_NATIONS.includes(cleaned) || TIER2_NATIONS.includes(cleaned);
  };

  const isT1Team = (teamStr) => {
    const cleaned = teamStr.replace(/\b(women|men|xi|national)\b/g, '').trim();
    return TIER1_NATIONS.includes(cleaned);
  };

  const p1IsT1 = isT1Team(p1);
  const p2IsT1 = isT1Team(p2);
  const p1IsNational = isNationalTeam(p1);
  const p2IsNational = isNationalTeam(p2);

  // Both teams are Tier 1 (e.g. England vs Sri Lanka, South Africa vs Australia)
  if (p1IsT1 && p2IsT1) {
    return true;
  }

  // One team is Tier 1 and other is national team, in an international series/tournament
  if ((p1IsT1 || p2IsT1) && (p1IsNational && p2IsNational)) {
    return true;
  }

  // Both are national teams in an official ICC / international series
  if (isInternationalSeries && p1IsNational && p2IsNational) {
    return true;
  }

  return false;
}

async function run() {
  console.log('Testing BPExch Filter on Oddspapi fixtures...');
  const fixtures = await fetchUrl(`https://v5.oddspapi.io/en/fixtures?apiKey=${API_KEY}&sportId=27`);
  if (!Array.isArray(fixtures)) {
    console.log('Failed to fetch:', fixtures);
    return;
  }

  console.log(`Total fixtures returned by API: ${fixtures.length}`);
  const accepted = fixtures.filter(isMatchForBPExch);
  console.log(`BPExch accepted fixtures: ${accepted.length}\n`);

  for (const f of accepted) {
    const p1 = f.participants?.participant1Name;
    const p2 = f.participants?.participant2Name;
    const t = f.tournament?.tournamentName;
    const date = new Date((f.startTime || 0) * 1000).toISOString();
    console.log(`🎯 [ACCEPTED] ${p1} vs ${p2} | League: ${t} | Date: ${date} | Status: ${f.status?.statusName}`);
  }
}

run();
