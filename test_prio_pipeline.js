const { getData } = require('./services/apiManager');
const https = require('https');

const API_KEY = '47867a6c1b58b5b0c53fdf6fe4fed924';

function fetchUrl(u) {
  return new Promise((resolve, reject) => {
    https.get(u, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TIER1_TEAMS = new Set([
  'india', 'australia', 'england', 'south africa', 'pakistan',
  'new zealand', 'sri lanka', 'west indies', 'bangladesh',
  'afghanistan', 'zimbabwe', 'ireland'
]);

const TIER2_TEAMS = new Set([
  'netherlands', 'scotland', 'namibia', 'nepal', 'oman',
  'united arab emirates', 'uae', 'canada', 'usa', 'united states',
  'uganda', 'papua new guinea', 'png', 'hong kong', 'hong kong china',
  'kenya', 'italy', 'jersey', 'kuwait', 'qatar', 'saudi arabia',
  'singapore', 'malaysia', 'nigeria', 'bermuda', 'bahamas', 'cayman',
  'tanzania', 'rwanda', 'ghana', 'sierra leone', 'bhutan', 'maldives',
  'japan', 'fiji', 'vanuatu', 'samoa', 'indonesia', 'philippines'
]);

function isVirtualOrSimulated(fixture) {
  const combined = normalizeText([
    fixture?.tournament?.tournamentName,
    fixture?.participants?.participant1Name,
    fixture?.participants?.participant2Name,
    fixture?.league,
    fixture?.home_team,
    fixture?.away_team,
  ].join(' '));

  return /\b(srl|simulated|virtual|electronic|esports|cyber)\b/.test(combined);
}

function getCricketPriority(fixture) {
  if (isVirtualOrSimulated(fixture)) return -1; // Blocked

  const tName = normalizeText(fixture?.tournament?.tournamentName || fixture?.league || '');
  const p1 = normalizeText(fixture?.participants?.participant1Name || fixture?.home_team || '');
  const p2 = normalizeText(fixture?.participants?.participant2Name || fixture?.away_team || '');
  const combined = `${tName} ${p1} ${p2}`;

  const isT1Team1 = Array.from(TIER1_TEAMS).some(t => p1.includes(t));
  const isT1Team2 = Array.from(TIER1_TEAMS).some(t => p2.includes(t));
  const isT2Team1 = Array.from(TIER2_TEAMS).some(t => p1.includes(t));
  const isT2Team2 = Array.from(TIER2_TEAMS).some(t => p2.includes(t));

  const isBilateralOrICC = /\b(odi series|test series|t20i series|t20 series|world cup|asia cup|champions trophy|icc|tri series|bilateral)\b/.test(tName);

  // Live match boost
  const isLive = Boolean(fixture?.status?.live || fixture?.status === 'live');
  const liveBonus = isLive ? 200 : 0;

  // Tier 1: Two Full Member / Tier 1 teams (e.g. England vs Sri Lanka, South Africa vs Australia)
  if (isT1Team1 && isT1Team2) {
    return liveBonus + 100;
  }

  // Tier 1b: One Full Member team in international series or ICC tournament
  if ((isT1Team1 || isT1Team2) && isBilateralOrICC) {
    return liveBonus + 90;
  }

  // Tier 2: Associate international matches (Asian Games, T20 World Cup Qualifier, etc.)
  if ((isT2Team1 || isT2Team2) && (isBilateralOrICC || /\b(asian games|qualifier|cup|quadrangular|challenge league)\b/.test(tName))) {
    return liveBonus + 70;
  }

  // Tier 3: Major domestic tournament with international stars (County Championship, IPL, BBL, PSL, CPL, etc.)
  if (/\b(county championship|ipl|indian premier league|big bash|bbl|psl|cpl|the hundred|marsh one day|super smash)\b/.test(tName)) {
    return liveBonus + 40;
  }

  // Tier 4: Other domestic cricket
  return liveBonus + 10;
}

async function run() {
  const nowTs = Math.floor(Date.now() / 1000);
  const fixtures = await getData('fixtures', {
    params: {
      startTimeFrom: nowTs,
      startTimeTo: nowTs + 7 * 24 * 3600
    }
  });

  const validFixtures = fixtures.filter(f => !isVirtualOrSimulated(f));
  
  // Sort fixtures by priority DESC, then startTime ASC
  validFixtures.sort((a, b) => {
    const prioA = getCricketPriority(a);
    const prioB = getCricketPriority(b);
    if (prioB !== prioA) return prioB - prioA;
    return (a.startTime || 0) - (b.startTime || 0);
  });

  console.log(`Top 15 Fixtures by International Priority:\n`);
  validFixtures.slice(0, 15).forEach((f, idx) => {
    const prio = getCricketPriority(f);
    const p1 = f.participants?.participant1Name;
    const p2 = f.participants?.participant2Name;
    const t = f.tournament?.tournamentName;
    const date = new Date(f.startTime * 1000).toLocaleString();
    console.log(`${idx+1}. [Prio: ${prio}] ${p1} vs ${p2} | ${t} | ${date}`);
  });
}

run().catch(console.error);
