const Match = require('../models/Match');

// Dynamic / resilient loader for pricingEngine to support both CommonJS and ES Module environments (e.g. Vercel Lambda Node 18/20/22/24)
let pricingEngine = null;
try {
  pricingEngine = require('./pricing/pricingEngine.js');
  if (pricingEngine && pricingEngine.default) pricingEngine = { ...pricingEngine.default, ...pricingEngine };
} catch (e) {
  // If CommonJS require() of ESM is blocked by this Node runtime, load via async import()
  import('./pricing/pricingEngine.js').then(m => {
    pricingEngine = m.default ? { ...m.default, ...m } : m;
  }).catch(() => {});
}

async function getPricingEngine() {
  if (pricingEngine) return pricingEngine;
  try {
    const m = await import('./pricing/pricingEngine.js');
    pricingEngine = m.default ? { ...m.default, ...m } : m;
    return pricingEngine;
  } catch (err) {
    console.warn('[FancyMarketsService] Could not load pricingEngine dynamically:', err.message);
    return null;
  }
}

let suspensionEngine = null;
async function getSuspensionEngine() {
  if (suspensionEngine) return suspensionEngine;
  try {
    suspensionEngine = require('./suspension/suspensionEngine.js');
    if (suspensionEngine && suspensionEngine.default) suspensionEngine = { ...suspensionEngine.default, ...suspensionEngine };
    return suspensionEngine;
  } catch (e) {
    try {
      const m = await import('./suspension/suspensionEngine.js');
      suspensionEngine = m.default ? { ...m.default, ...m } : m;
      return suspensionEngine;
    } catch (err) {
      return null;
    }
  }
}

class FancyMarketsService {
  constructor() {
    this.io = null;
    this.matchCache = new Map();
    this.lastDbUpdateTime = new Map();
    this.lastSuspensionTime = new Map();
    this.computedOddsCache = new Map();
  }

  /**
   * Cached & throttled calibrated Monte Carlo odds computation (recomputes when score changes or >=5s)
   */
  getCalibratedOdds(match) {
    if (!match || !pricingEngine || !pricingEngine.computeMatchOdds) return null;
    const matchId = String(match.matchId || match._id || 'match');
    const now = Date.now();
    const scoreKey = `${match.status}_${match.score?.overs}_${match.score?.runs}_${match.score?.wickets}_${match.score?.battingTeam}`;

    const cached = this.computedOddsCache.get(matchId);
    if (cached && cached.scoreKey === scoreKey && (now - cached.time < 5000)) {
      return cached.computed;
    }

    try {
      const computed = pricingEngine.computeMatchOdds(match);
      this.computedOddsCache.set(matchId, { scoreKey, time: now, computed });
      return computed;
    } catch (calcErr) {
      console.warn(`[FancyMarketsService] Pricing calc warning for ${matchId}:`, calcErr.message);
      return cached ? cached.computed : null;
    }
  }

  /**
   * Helper to derive short team codes (e.g. "South Africa Legends" -> "SA-L")
   */
  getShortTeamCode(teamName) {
    if (pricingEngine && typeof pricingEngine.getShortTeamCode === 'function') {
      return pricingEngine.getShortTeamCode(teamName);
    }
    if (!teamName) return 'TEAM';
    const clean = teamName.trim();
    const lower = clean.toLowerCase();
    if (lower.includes('south africa')) return 'SA-L';
    if (lower.includes('west indies')) return 'WI-L';
    if (lower.includes('australia')) return 'AUS-L';
    if (lower.includes('pakistan')) return 'PAK-L';
    if (lower.includes('india')) return 'IND-L';
    if (lower.includes('england')) return 'ENG-L';
    if (lower.includes('bangladesh')) return 'BAN-L';
    if (lower.includes('sri lanka') || lower.includes('srilanka')) return 'SL-L';
    if (lower.includes('new zealand') || lower.includes('newzealand')) return 'NZ-L';
    if (lower.includes('afghanistan')) return 'AFG-L';
    return clean.slice(0, 4).toUpperCase();
  }

  /**
   * Helper to format volume numbers into readable strings (e.g. 150, 1.2K, 3.4M)
   */
  formatVolume(size) {
    if (size === undefined || size === null || isNaN(size)) return '100';
    const sz = Number(size);
    if (sz >= 1000000) return `${(sz / 1000000).toFixed(1)}M`;
    if (sz >= 1000) return `${(sz / 1000).toFixed(1)}K`;
    return Math.round(sz).toString();
  }

  /**
   * Format available back/lay depth arrays from OddsPapi meta quotes
   */
  formatDepthSlots(available) {
    if (!Array.isArray(available)) return [];
    return available.slice(0, 3).map(slot => ({
      price: Number(slot.price),
      volume: this.formatVolume(slot.size)
    }));
  }

  /**
   * Extract real-time Tied Match (Others) market directly from Oddspapi quotes
   * (target Betfair Exchange marketId 276 / 274 or 1X2 market 273)
   */
  extractTiedMatch(normalizedOdds) {
    if (!normalizedOdds || typeof normalizedOdds !== 'object') {
      return {
        name: 'TIED MATCH',
        maxBet: 500000,
        status: 'SUSPENDED',
        runners: [
          { name: 'Yes', backOdds: [{ price: 25.0, volume: '100' }], layOdds: [{ price: 30.0, volume: '100' }] },
          { name: 'No', backOdds: [{ price: 1.02, volume: '1.5M' }], layOdds: [{ price: 1.04, volume: '1.5M' }] }
        ]
      };
    }

    for (const [bkKey, outcomes] of Object.entries(normalizedOdds)) {
      if (!outcomes || typeof outcomes !== 'object') continue;
      const quotes = Array.isArray(outcomes) ? outcomes : Object.values(outcomes);

      // 1. Dedicated Tied Match Market (MarketId 276 or 274)
      const tiedQuotes = quotes.filter(q => q && (q.marketId === 276 || q.marketId === 274 || String(q.marketType).includes('tied-match')));
      if (tiedQuotes.length > 0) {
        const yesQuote = tiedQuotes.find(q => q.outcomeId === 276 || q.outcomeName === '1' || q.outcomeName === 'Yes') || tiedQuotes[0];
        const noQuote = tiedQuotes.find(q => q.outcomeId === 277 || q.outcomeName === '2' || q.outcomeName === 'No');

        const yesBack = yesQuote?.meta?.availableToBack?.length > 0
          ? this.formatDepthSlots(yesQuote.meta.availableToBack)
          : (yesQuote?.price ? [{ price: Number(yesQuote.price), volume: this.formatVolume(yesQuote.limit) }] : []);

        const yesLay = yesQuote?.meta?.availableToLay?.length > 0
          ? this.formatDepthSlots(yesQuote.meta.availableToLay)
          : (yesBack.length > 0 ? [{ price: Number((yesBack[0].price * 1.05).toFixed(1)), volume: '100' }] : []);

        const noBack = noQuote?.meta?.availableToBack?.length > 0
          ? this.formatDepthSlots(noQuote.meta.availableToBack)
          : (noQuote?.price ? [{ price: Number(noQuote.price), volume: this.formatVolume(noQuote.limit) }] : []);

        const noLay = noQuote?.meta?.availableToLay?.length > 0
          ? this.formatDepthSlots(noQuote.meta.availableToLay)
          : (noBack.length > 0 ? [{ price: Number((noBack[0].price * 1.02).toFixed(2)), volume: '100' }] : []);

        const isMarketOpen = (yesQuote && yesQuote.active !== false && yesQuote.price > 0) || (noQuote && noQuote.active !== false);

        return {
          name: 'TIED MATCH',
          maxBet: 500000,
          status: isMarketOpen ? 'OPEN' : 'SUSPENDED',
          runners: [
            {
              name: 'Yes',
              backOdds: yesBack,
              layOdds: yesLay
            },
            {
              name: 'No',
              backOdds: noBack,
              layOdds: noLay
            }
          ]
        };
      }

      // 2. Fallback to 1X2 Market (MarketId 273), where Outcome 274 is Tie ("X")
      const x2Quotes = quotes.filter(q => q && (q.marketId === 273 || q.marketType === '1x2'));
      const tieOutcome = x2Quotes.find(q => q.outcomeId === 274 || q.outcomeName === 'X');
      if (tieOutcome && tieOutcome.price > 0) {
        const yesBack = tieOutcome.meta?.availableToBack?.length > 0
          ? this.formatDepthSlots(tieOutcome.meta.availableToBack)
          : [{ price: Number(tieOutcome.price), volume: this.formatVolume(tieOutcome.limit) }];

        const yesLay = tieOutcome.meta?.availableToLay?.length > 0
          ? this.formatDepthSlots(tieOutcome.meta.availableToLay)
          : [];

        return {
          name: 'TIED MATCH',
          maxBet: 500000,
          status: tieOutcome.active !== false ? 'OPEN' : 'SUSPENDED',
          runners: [
            {
              name: 'Yes',
              backOdds: yesBack,
              layOdds: yesLay
            },
            {
              name: 'No',
              backOdds: [],
              layOdds: [{ price: 1.02, volume: '1.5M' }]
            }
          ]
        };
      }
    }

    return {
      name: 'TIED MATCH',
      maxBet: 500000,
      status: 'SUSPENDED',
      runners: [
        { name: 'Yes', backOdds: [], layOdds: [] },
        { name: 'No', backOdds: [], layOdds: [] }
      ]
    };
  }

  /**
   * Extract or assemble Even / Odd markets.
   * Uses real bookmaker quotes if present, otherwise uses calibrated Monte Carlo engine.
   */
  extractEvenOddMarkets(normalizedOdds, match, computed = null) {
    if (computed?.evenOddMarkets && computed.evenOddMarkets.length > 0) {
      return computed.evenOddMarkets;
    }

    let oddQuote = null;
    let evenQuote = null;

    if (normalizedOdds) {
      for (const [bk, outcomes] of Object.entries(normalizedOdds)) {
        if (!outcomes || typeof outcomes !== 'object') continue;
        const quotes = Array.isArray(outcomes) ? outcomes : Object.values(outcomes);
        const eoQuotes = quotes.filter(q => q && (q.marketId === 2724029 || String(q.marketType).includes('oddeven')));
        if (eoQuotes.length > 0) {
          oddQuote = eoQuotes.find(q => q.outcomeId === 2724029 || q.outcomeName === 'Odd') || eoQuotes[0];
          evenQuote = eoQuotes.find(q => q.outcomeId === 2724030 || q.outcomeName === 'Even') || eoQuotes[1];
          break;
        }
      }
    }

    if (oddQuote && oddQuote.price > 0 && oddQuote.active !== false) {
      const bPrice = Number(oddQuote.price);
      const lPrice = Number((bPrice + 0.04).toFixed(2));
      return [
        {
          name: '1st inn 15 Over Run Odd (Kalli)',
          backPrice: bPrice,
          backVol: this.formatVolume(oddQuote.limit || 100),
          layPrice: lPrice,
          layVol: this.formatVolume(oddQuote.limit || 100),
          status: 'OPEN',
          maxBet: 2000000
        },
        {
          name: '1st inn 20 Over Run Odd (Kalli)',
          backPrice: evenQuote?.price ? Number(evenQuote.price) : bPrice,
          backVol: '100',
          layPrice: evenQuote?.price ? Number((evenQuote.price + 0.04).toFixed(2)) : lPrice,
          layVol: '100',
          status: 'OPEN',
          maxBet: 2000000
        }
      ];
    }

    // Default calculated fallback
    try {
      const res = (pricingEngine && typeof pricingEngine.computeMatchOdds === 'function') ? pricingEngine.computeMatchOdds(match) : null;
      if (res?.evenOddMarkets?.length > 0) return res.evenOddMarkets;
    } catch (e) {}

    return [
      {
        name: '1st inn 15 Over Run Odd (Kalli)',
        backPrice: null,
        backVol: '100',
        layPrice: null,
        layVol: '100',
        status: 'SUSPENDED',
        maxBet: 2000000
      },
      {
        name: '1st inn 20 Over Run Odd (Kalli)',
        backPrice: null,
        backVol: '100',
        layPrice: null,
        layVol: '100',
        status: 'SUSPENDED',
        maxBet: 2000000
      }
    ];
  }

  /**
   * Extract or assemble Fancy 2 markets for live match.
   * Uses real bookmaker quotes if present, otherwise uses calibrated Monte Carlo engine.
   */
  extractFancyMarkets(normalizedOdds, match, computed = null) {
    if (computed?.fancyMarkets && computed.fancyMarkets.length > 0) {
      return computed.fancyMarkets;
    }

    const teamA = match.teamA || 'Team A';
    const teamB = match.teamB || 'Team B';
    const shortA = this.getShortTeamCode(teamA);
    const shortB = this.getShortTeamCode(teamB);

    const overQuotes = {};
    const wktQuotes = {};
    const overLineRe = /(\d+)[_\s-]?over/i;
    const wktRe = /(\d+)(?:st|nd|rd|th)?\s*wkt/i;

    if (normalizedOdds) {
      for (const [, outcomes] of Object.entries(normalizedOdds)) {
        if (!outcomes || typeof outcomes !== 'object') continue;
        const quotes = Array.isArray(outcomes) ? outcomes : Object.values(outcomes);
        for (const q of quotes) {
          if (!q || !q.marketType) continue;
          const mt = String(q.marketType);
          const name = String(q.name || q.marketType || '');
          const isActive = q.price > 0 && q.active !== false && q.status !== 'SUSPENDED';

          const overMatch = overLineRe.exec(mt) || overLineRe.exec(name);
          if (overMatch) {
            const n = String(parseInt(overMatch[1], 10));
            if (!overQuotes[n] && isActive) {
              overQuotes[n] = q;
            }
          }

          const wktMatch = wktRe.exec(mt) || wktRe.exec(name);
          if (wktMatch) {
            const n = String(parseInt(wktMatch[1], 10));
            if (!wktQuotes[n] && isActive) {
              wktQuotes[n] = q;
            }
          }
        }
      }
    }

    if (Object.keys(overQuotes).length > 0 || Object.keys(wktQuotes).length > 0) {
      const makeOverRow = (label, overN) => {
        const q = overQuotes[String(overN)];
        return {
          name: label,
          overN,
          backPrice: q ? Number(q.handicap || q.price) : null,
          backVol: q ? this.formatVolume(q.limit) : '100',
          layPrice: q ? Number((q.handicap || q.price) - 1) : null,
          layVol: q ? this.formatVolume(q.limit) : '100',
          status: q ? 'OPEN' : 'SUSPENDED',
          maxBet: 2000000
        };
      };

      const makeWktRow = (label, wktN) => {
        const q = wktQuotes[String(wktN)];
        return {
          name: label,
          wicketN: wktN,
          backPrice: q ? Number(q.handicap || q.price) : null,
          backVol: q ? this.formatVolume(q.limit) : '100',
          layPrice: q ? Number((q.handicap || q.price) + 1) : null,
          layVol: q ? this.formatVolume(q.limit) : '100',
          status: q ? 'OPEN' : 'SUSPENDED',
          maxBet: 2000000
        };
      };

      return [
        makeOverRow(`6 Over Run ${shortA}`, 6),
        makeOverRow(`7 Over Run ${shortA}`, 7),
        makeOverRow(`8 Over Run ${shortA}`, 8),
        makeOverRow(`10 Over Run ${shortA}`, 10),
        makeOverRow(`15 Over Run ${shortA}`, 15),
        {
          name: `11 Over Run Only ${shortA}`,
          backPrice: null,
          backVol: '100',
          layPrice: null,
          layVol: '100',
          status: 'SUSPENDED',
          maxBet: 2000000
        },
        makeOverRow(`20 Over Run ${shortA}`, 20),
        makeWktRow(`Fall of 1st Wkt ${shortA}`, 1),
        makeWktRow(`Fall of 2nd Wkt ${shortA}`, 2),
        makeWktRow(`Fall of 3rd Wkt ${shortA}`, 3),
        makeOverRow(`10 Over Run ${shortB}`, 10),
        makeWktRow(`Fall of 1st Wkt ${shortB}`, 1)
      ];
    }

    // Default calculated fallback
    try {
      const res = (pricingEngine && typeof pricingEngine.computeMatchOdds === 'function') ? pricingEngine.computeMatchOdds(match) : null;
      if (res?.fancyMarkets?.length > 0) return res.fancyMarkets;
    } catch (e) {}

    return [
      { name: `6 Over Run ${shortA}`, backPrice: null, layPrice: null, status: 'SUSPENDED' },
      { name: `10 Over Run ${shortA}`, backPrice: null, layPrice: null, status: 'SUSPENDED' },
      { name: `15 Over Run ${shortA}`, backPrice: null, layPrice: null, status: 'SUSPENDED' },
      { name: `20 Over Run ${shortA}`, backPrice: null, layPrice: null, status: 'SUSPENDED' }
    ];
  }

  /**
   * Extract or assemble Figure (0-9 Digits) markets for live match.
   */
  extractFigureMarkets(normalizedOdds, match, computed = null) {
    if (computed?.figureMarkets && computed.figureMarkets.length > 0) {
      return computed.figureMarkets;
    }

    try {
      const res = (pricingEngine && typeof pricingEngine.computeMatchOdds === 'function') ? pricingEngine.computeMatchOdds(match) : null;
      if (res?.figureMarkets?.length > 0) return res.figureMarkets;
    } catch (e) {}

    const teamA = match.teamA || 'Team A';
    const digits = Array.from({ length: 10 }, (_, i) => ({
      digit: i,
      odds: 8.85,
      status: 'SUSPENDED'
    }));

    return [
      {
        name: `${teamA.toUpperCase()} 15 OVER TOTAL LAST FIGURE`,
        maxBet: 100000,
        status: 'SUSPENDED',
        digits
      }
    ];
  }

  /**
   * Ensure a single match document has all required markets (Match Odds, Bookmaker, Toss, Scorecard, Figure, Fancy, Even-Odd).
   * For live matches, live calibrated quotes are calculated.
   */
  async ensureMatchMarkets(match, io = null) {
    if (!match) return match;

    // Merge authoritative in-memory / Redis live score from Roanuz
    try {
      const { roanuzScoreService } = require('./roanuzScoreService');
      const hotScore = await roanuzScoreService.getLiveScore(match.matchId) ||
        (match.roanuzMatchKey ? await roanuzScoreService.getLiveScore(match.roanuzMatchKey) : null);
      if (hotScore) {
        match.score = {
          ...(match.score || {}),
          ...hotScore,
          lastUpdated: new Date()
        };
        if (hotScore.format && !match.format) match.format = hotScore.format;
      }
    } catch (e) {}

    // Compute calibrated Monte Carlo odds (cached & throttled)
    await getPricingEngine();
    const computed = this.getCalibratedOdds(match);

    let hasChanges = false;

    // 1. Fancy Markets
    if (computed?.fancyMarkets?.length > 0) {
      match.fancyMarkets = computed.fancyMarkets;
      hasChanges = true;
    } else if (!match.fancyMarkets || match.fancyMarkets.length === 0) {
      match.fancyMarkets = this.extractFancyMarkets(null, match, computed);
      hasChanges = true;
    }

    // 2. Figure Markets (0-9 Digits)
    if (computed?.figureMarkets?.length > 0) {
      match.figureMarkets = computed.figureMarkets;
      hasChanges = true;
    } else if (!match.figureMarkets || match.figureMarkets.length === 0) {
      match.figureMarkets = this.extractFigureMarkets(null, match, computed);
      hasChanges = true;
    }

    // 3. Even/Odd Markets
    if (computed?.evenOddMarkets?.length > 0) {
      match.evenOddMarkets = computed.evenOddMarkets;
      hasChanges = true;
    } else if (!match.evenOddMarkets || match.evenOddMarkets.length === 0) {
      match.evenOddMarkets = this.extractEvenOddMarkets(null, match, computed);
      hasChanges = true;
    }

    // 4. Tied Match (Others)
    if (!match.tiedMatchMarket) {
      match.tiedMatchMarket = this.extractTiedMatch(null);
      hasChanges = true;
    }

    // 5. Default Bookmaker odds if missing, and ensure proper status
    const isStumpsBreak = Boolean(
      match.score?.statusText?.toLowerCase()?.includes('stump') ||
      match.statusText?.toLowerCase()?.includes('stump')
    );

    if (!match.bookmakerBackA && match.backOddsA && match.bookmakerMarketStatus !== 'SUSPENDED') {
      match.bookmakerBackA = match.backOddsA;
      match.bookmakerLayA = match.layOddsA ? Number((match.layOddsA > match.backOddsA ? match.layOddsA + 0.01 : match.backOddsA + 0.02).toFixed(2)) : 1.97;
      match.bookmakerBackB = match.backOddsB ? Number((match.backOddsB >= 2 ? match.backOddsB - 0.02 : match.backOddsB).toFixed(2)) : 2.05;
      match.bookmakerLayB = match.layOddsB ? Number((match.layOddsB >= 2 ? match.layOddsB + 0.02 : match.layOddsB + 0.02).toFixed(2)) : 2.08;
      if (match.isTestMatch && match.backOddsDraw) {
        match.bookmakerBackDraw = match.backOddsDraw;
        match.bookmakerLayDraw = match.layOddsDraw ? Number((match.layOddsDraw > match.backOddsDraw ? match.layOddsDraw + 0.01 : match.backOddsDraw + 0.02).toFixed(2)) : Number((match.backOddsDraw + 0.02).toFixed(2));
      }
      match.bookmakerMarketStatus = isStumpsBreak ? 'SUSPENDED' : 'OPEN';
      hasChanges = true;
    }
    if ((match.bookmakerBackA || match.backOddsA) && match.status !== 'completed' && match.status !== 'resulted') {
      if (match.bookmakerMarketStatus !== 'SUSPENDED' && match.bookmakerMarketStatus !== 'CLOSED' && !isStumpsBreak) {
        match.bookmakerMarketStatus = 'OPEN';
        hasChanges = true;
      }
      if (match.marketStatus === 'SUSPENDED' && !isStumpsBreak) {
        match.marketStatus = 'OPEN';
        hasChanges = true;
      }
    }

    // 6. Toss odds handling
    const now = new Date();
    const isStartedOrLive = match.status === 'live' || match.status === 'completed' || match.status === 'resulted' || (match.startTime && now >= new Date(match.startTime));

    if (isStartedOrLive) {
      if (match.tossMarketStatus !== 'CLOSED' || match.tossBackA !== null) {
        match.tossMarketStatus = 'CLOSED';
        match.tossBackA = null;
        match.tossLayA = null;
        match.tossBackB = null;
        match.tossLayB = null;
        match.tossDepthBackA = '0';
        match.tossDepthLayA = '0';
        match.tossDepthBackB = '0';
        match.tossDepthLayB = '0';
        hasChanges = true;
      }
    } else if (!match.tossWinner) {
      if (match.tossBackA !== 1.98 || match.tossLayA !== 2.02 || match.tossBackB !== 1.98 || match.tossLayB !== 2.02 || match.tossMarketStatus !== 'OPEN') {
        match.tossBackA = 1.98;
        match.tossLayA = 2.02;
        match.tossBackB = 1.98;
        match.tossLayB = 2.02;
        match.tossDepthBackA = "100";
        match.tossDepthLayA = "100";
        match.tossDepthBackB = "100";
        match.tossDepthLayB = "100";
        match.tossMarketStatus = 'OPEN';
        hasChanges = true;
      }
    }

    if (hasChanges) {
      try {
        const altId = String(match.matchId).startsWith('id') ? String(match.matchId).replace(/^id/, '') : ('id' + String(match.matchId));
        await Match.updateOne(
          { $or: [{ matchId: match.matchId }, { matchId: altId }, { roanuzMatchKey: match.roanuzMatchKey || match.matchId }] },
          {
            $set: {
              fancyMarkets: match.fancyMarkets,
              figureMarkets: match.figureMarkets,
              evenOddMarkets: match.evenOddMarkets,
              tiedMatchMarket: match.tiedMatchMarket,
              bookmakerBackA: match.bookmakerBackA,
              bookmakerLayA: match.bookmakerLayA,
              bookmakerBackB: match.bookmakerBackB,
              bookmakerLayB: match.bookmakerLayB,
              bookmakerMarketStatus: match.bookmakerMarketStatus || 'OPEN',
              tossBackA: match.tossBackA,
              tossLayA: match.tossLayA,
              tossBackB: match.tossBackB,
              tossLayB: match.tossLayB,
              tossDepthBackA: match.tossDepthBackA,
              tossDepthLayA: match.tossDepthLayA,
              tossDepthBackB: match.tossDepthBackB,
              tossDepthLayB: match.tossDepthLayB,
              tossMarketStatus: match.tossMarketStatus
            }
          }
        );
      } catch (err) {}
    }

    // Run suspension engine evaluation with statsMap
    try {
      const se = await getSuspensionEngine();
      if (se && se.evaluateMatch) {
        await se.evaluateMatch(match.matchId, {
          match,
          statsMap: computed?.statsByMarket || null
        });
      }
    } catch (sErr) {}

    return match;
  }

  /**
   * Real-Time Pipeline processor called whenever live odds arrive or scores update.
   * Extracts or computes Tied Match, Even/Odd, Fancy 2, and Figure markets,
   * throttles DB writes & suspension evaluation, and emits WebSocket events to the frontend.
   */
  async processLiveMarkets({ matchId, normalizedOdds, io = null, isLive = true }) {
    try {
      const now = Date.now();
      const altMatchId = String(matchId).startsWith('id') ? String(matchId).replace(/^id/, '') : ('id' + String(matchId));
      let match = null;
      const cached = this.matchCache.get(matchId) || this.matchCache.get(altMatchId);
      if (cached && (now - cached.timestamp < 10000)) {
        match = cached.match;
      } else {
        match = await Match.findOne({
          $or: [
            { matchId },
            { matchId: altMatchId },
            { roanuzMatchKey: matchId },
            { roanuzMatchKey: altMatchId }
          ]
        });
        if (match) {
          this.matchCache.set(matchId, { match, timestamp: now });
          this.matchCache.set(altMatchId, { match, timestamp: now });
        }
      }
      if (!match) return;

      // Merge latest hot score from Roanuz (0ms latency)
      try {
        const { roanuzScoreService } = require('./roanuzScoreService');
        const hotScore = await roanuzScoreService.getLiveScore(match.matchId) ||
          await roanuzScoreService.getLiveScore(altMatchId) ||
          (match.roanuzMatchKey ? await roanuzScoreService.getLiveScore(match.roanuzMatchKey) : null);
        if (hotScore) {
          match.score = {
            ...(match.score || {}),
            ...hotScore,
            lastUpdated: new Date()
          };
          if (hotScore.format && !match.format) match.format = hotScore.format;
        }
      } catch (e) {}

      const isActuallyLive = isLive || match.status === 'live' || match.inplay === true;

      // 1. Extract real Tied Match from Betfair Exchange quotes
      const tiedMatchMarket = this.extractTiedMatch(normalizedOdds);

      // 2. Compute calculated odds via pricingEngine (cached & throttled)
      const computed = this.getCalibratedOdds(match);

      // 3. Assemble markets
      const fancyMarkets = (computed?.fancyMarkets?.length > 0)
        ? computed.fancyMarkets
        : this.extractFancyMarkets(normalizedOdds, match, computed);

      const figureMarkets = (computed?.figureMarkets?.length > 0)
        ? computed.figureMarkets
        : this.extractFigureMarkets(normalizedOdds, match, computed);

      const evenOddMarkets = (computed?.evenOddMarkets?.length > 0)
        ? computed.evenOddMarkets
        : this.extractEvenOddMarkets(normalizedOdds, match, computed);

      // Update match document in cache/memory
      match.tiedMatchMarket = tiedMatchMarket;
      match.evenOddMarkets = evenOddMarkets;
      match.fancyMarkets = fancyMarkets;
      match.figureMarkets = figureMarkets;

      // Throttle DB write to at most once per 2 seconds per match
      const lastDbUpdate = this.lastDbUpdateTime.get(matchId) || 0;
      if (now - lastDbUpdate >= 2000) {
        this.lastDbUpdateTime.set(matchId, now);
        this.lastDbUpdateTime.set(altMatchId, now);
        Match.updateOne(
          { $or: [{ matchId: match.matchId }, { matchId: altMatchId }, { roanuzMatchKey: match.roanuzMatchKey || match.matchId }] },
          {
            $set: {
              tiedMatchMarket,
              evenOddMarkets,
              fancyMarkets,
              figureMarkets
            }
          }
        ).catch(e => console.warn(`[FancyMarketsService] DB update warning for ${matchId}:`, e.message));
      }

      // Evaluate suspension with pricing stats
      const lastSuspension = this.lastSuspensionTime.get(matchId) || 0;
      if (now - lastSuspension >= 2000) {
        this.lastSuspensionTime.set(matchId, now);
        this.lastSuspensionTime.set(altMatchId, now);
        try {
          const se = await getSuspensionEngine();
          if (se && se.evaluateMatch) {
            await se.evaluateMatch(match.matchId, {
              match,
              statsMap: computed?.statsByMarket || null
            });
          }
        } catch (e) {
          console.error(`[FancyMarketsService] Suspension evaluation error:`, e.message);
        }
      }

      // Emit live updates via Socket.IO immediately
      const targetIo = io || this.io;
      if (targetIo) {
        const matchIdStr = String(match.matchId);
        const altMatchId = matchIdStr.startsWith('id') ? matchIdStr.replace(/^id/, '') : ('id' + matchIdStr);
        const emitTargets = [matchIdStr, altMatchId];
        if (match.roanuzMatchKey && !emitTargets.includes(match.roanuzMatchKey)) {
          emitTargets.push(match.roanuzMatchKey);
        }

        for (const tId of emitTargets) {
          targetIo.emit('tied_match_market_update', { matchId: tId, tiedMatchMarket });
          targetIo.emit('even_odd_market_update', { matchId: tId, evenOddMarkets: match.evenOddMarkets });
          targetIo.emit('fancy_market_update', { matchId: tId, fancyMarkets: match.fancyMarkets });
          targetIo.emit('figure_market_update', { matchId: tId, figureMarkets: match.figureMarkets });
        }
      }
    } catch (err) {
      console.error(`[FancyMarketsService] Error processing live markets for ${matchId}:`, err.message);
    }
  }

  /**
   * Real-time hook called when live scores or odds arrive
   */
  async handleLiveMatchOdds(matchId, io, normalizedOdds = null) {
    await this.processLiveMarkets({ matchId, normalizedOdds, io: io || this.io, isLive: true });
  }

  /**
   * Initialize service
   */
  init(io) {
    this.io = io;
    console.log('✅ FancyMarketsService real-time pipeline initialized (pure live calculated odds)');
  }
}

module.exports = new FancyMarketsService();
