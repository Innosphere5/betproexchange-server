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

async function inspect() {
  const data = await fetchUrl(`https://v5.oddspapi.io/en/fixtures/odds?apiKey=${API_KEY}&fixtureId=id2703445667132182`);
  console.log('Bookmakers:', Object.keys(data.odds || {}));
  for (const [bk, quotes] of Object.entries(data.odds || {})) {
    console.log(`\n--- Bookmaker: ${bk} (${Object.keys(quotes).length} quotes) ---`);
    for (const [key, q] of Object.entries(quotes)) {
      console.log(`Key: ${key}`);
      console.log(`  marketId: ${q.marketId}, outcomeId: ${q.outcomeId}, price: ${q.price}, active: ${q.active}, mainLine: ${q.mainLine}`);
      console.log(`  bookmakerMarketId: ${q.bookmakerMarketId}, bookmakerOutcomeId: ${q.bookmakerOutcomeId}`);
      console.log(`  meta Back:`, q.meta?.availableToBack);
      console.log(`  meta Lay:`, q.meta?.availableToLay);
    }
  }
}

inspect();
