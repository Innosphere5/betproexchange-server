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

function extractMatchOdds(oddsResponse) {
  if (!oddsResponse || !oddsResponse.odds) return null;

  const bookmakers = oddsResponse.odds;
  const preferredBookies = ['betfair-ex', 'betfair_ex', 'pinnacle'];
  
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

  const isExchange = usedBookie.includes('ex');
  const quotesList = Object.values(targetQuotes).filter(q => q && q.active !== false);

  // Group by marketId
  const byMarket = {};
  for (const q of quotesList) {
    const mId = q.marketId ?? 'default';
    if (!byMarket[mId]) byMarket[mId] = [];
    byMarket[mId].push(q);
  }

  // Find Match Odds market:
  // Preference 1: market with mainLine === true and 2 outcomes
  // Preference 2: market with 2 outcomes (h2h / winner)
  // Preference 3: marketId 271 or lowest marketId with 2 outcomes
  let winnerMarket = null;
  for (const [mId, grp] of Object.entries(byMarket)) {
    if (grp.length === 2 && grp.some(q => q.mainLine === true)) {
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

  winnerMarket.sort((a, b) => (Number(a.outcomeId) || 0) - (Number(b.outcomeId) || 0));

  const homeQ = winnerMarket[0];
  const awayQ = winnerMarket[1];

  let backOddsA = null, layOddsA = null, depthBackA = "0", depthLayA = "0";
  let backOddsB = null, layOddsB = null, depthBackB = "0", depthLayB = "0";

  if (isExchange) {
    if (homeQ.meta) {
      backOddsA = homeQ.meta.availableToBack?.[0]?.price || homeQ.price || null;
      depthBackA = homeQ.meta.availableToBack?.[0]?.size ? Math.round(homeQ.meta.availableToBack[0].size).toString() : "0";
      layOddsA = homeQ.meta.availableToLay?.[0]?.price || (backOddsA ? Number((backOddsA + 0.02).toFixed(2)) : null);
      depthLayA = homeQ.meta.availableToLay?.[0]?.size ? Math.round(homeQ.meta.availableToLay[0].size).toString() : "0";
    } else {
      backOddsA = homeQ.price;
      layOddsA = Number((homeQ.price + 0.01).toFixed(2));
    }

    if (awayQ.meta) {
      backOddsB = awayQ.meta.availableToBack?.[0]?.price || awayQ.price || null;
      depthBackB = awayQ.meta.availableToBack?.[0]?.size ? Math.round(awayQ.meta.availableToBack[0].size).toString() : "0";
      layOddsB = awayQ.meta.availableToLay?.[0]?.price || (backOddsB ? Number((backOddsB + 0.02).toFixed(2)) : null);
      depthLayB = awayQ.meta.availableToLay?.[0]?.size ? Math.round(awayQ.meta.availableToLay[0].size).toString() : "0";
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

async function test() {
  const odds = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/odds?apiKey=${API_KEY}&fixtureId=id2703445667132182`);
  const parsed = extractMatchOdds(odds);
  console.log('Parsed Odds for England vs Sri Lanka:');
  console.log(JSON.stringify(parsed, null, 2));
}

test();
