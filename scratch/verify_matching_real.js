const apiEvents = [
  {
    "id": 70343184,
    "home": "Lucknow Super Giants",
    "away": "Royal Challengers Bangalore",
    "date": "2026-05-07T14:00:00Z",
    "league": { "name": "India - Indian Premier League" }
  },
  {
    "id": 71098766,
    "home": "Malta",
    "away": "Gibraltar",
    "date": "2026-05-07T07:30:00Z",
    "league": { "name": "International - Twenty20 International" }
  }
];

const dbMatches = [
  {
    "matchId": "69644",
    "teamA": "Lucknow Super Giants",
    "teamB": "Royal Challengers Bengaluru",
    "startTime": new Date("2026-05-07T14:00:00Z")
  },
  {
    "matchId": "69861",
    "teamA": "Malta",
    "teamB": "Gibraltar",
    "startTime": new Date("2026-05-07T07:30:00Z")
  }
];

function normalize(name) {
    return name ? name.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '') : '';
}

function isTeamMatch(dbName, apiName) {
  const nA = normalize(dbName);
  const nB = normalize(apiName);
  if (nA === nB) return true;
  if (nA.includes(nB) || nB.includes(nA)) return true;
  
  const aliases = {
    'bengaluru': 'bangalore',
    'bangalore': 'bengaluru',
    'lucknow': 'lucknow super giants',
    'rcb': 'royal challengers bangalore'
  };
  if (aliases[nA] === nB || aliases[nB] === nA) return true;

  const firstA = nA.split(' ')[0];
  const firstB = nB.split(' ')[0];
  if (firstA.length > 4 && firstA === firstB) return true;

  return false;
}

console.log('Verifying Matching Logic with Real-world Data:');
dbMatches.forEach(dbMatch => {
    const apiMatch = apiEvents.find(event => {
        const apiTime = new Date(event.date);
        const timeDiff = Math.abs(apiTime - dbMatch.startTime) / (1000 * 60 * 60);
        if (timeDiff > 2) return false;

        const homeMatch = isTeamMatch(dbMatch.teamA, event.home) && isTeamMatch(dbMatch.teamB, event.away);
        const awayMatch = isTeamMatch(dbMatch.teamA, event.away) && isTeamMatch(dbMatch.teamB, event.home);
        return homeMatch || awayMatch;
    });

    if (apiMatch) {
        console.log(`✅ MATCHED: ${dbMatch.teamA} v ${dbMatch.teamB} with API: ${apiMatch.home} v ${apiMatch.away}`);
    } else {
        console.log(`❌ NO MATCH for ${dbMatch.teamA} v ${dbMatch.teamB}`);
    }
});
