const WebSocket = require("ws");
const Match = require("../models/Match");
const MarketOdds = require("../models/MarketOdds");
const OddsMarket = require("../models/OddsMarket");
const oddsApiRest = require("./oddsApiRest");
const { shouldIncludeFixture } = require("./fixtureFilter");
require("dotenv").config();

// ─── Configuration ─────────────────────────────────────────────────────────────

const API_KEY = process.env.ODDS_API_KEY || "6de1aca2c07d3f5abeb411b7157069e6";
const WS_BASE_URL = "wss://v5.oddspapi.io/ws";
const SPORT = "cricket";
const MARKETS = "h2h";
const CHANNELS = "odds,scores,status";
// Bookmaker targets are filtered here if needed, but the WS url might fetch all.
// The user noted: "Your current code targets betfair-ex (exchange) and pinnacle. On odds-api.io, the equivalent would be Betfair Exchange and Pinnacle. I'll use odds-api.io's naming convention."
// However, the internal API keys for these are typically betfair_ex and bet365.
const BOOKMAKERS = ["pinnacle", "betfair-ex", "betfair_ex"];
const STALE_TIMEOUT_MS = 600000; // 10 minutes — cricket has natural pauses (innings breaks, drinks, rain delays)

class OddsApiLiveService {
  constructor() {
    this.ws = null;
    this.io = null;

    // Resume state
    this.lastSeq = null;

    // Reconnect
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.reconnectTimer = null;
    this.isConnecting = false;

    // Fixture mapping: eventId → DB matchId
    this.eventToMatchId = new Map();
    // eventId → fixture metadata (home, away, etc.)
    this.eventMetadata = new Map();

    // Cached needsSwap per matchId to prevent DB queries on every tick
    this.swapCache = new Map();

    // Odds cache: DB matchId → latest odds payload (for dedup)
    this.oddsCache = new Map();

    // Batched DB write queue: DB matchId → update payload
    this.writeQueue = new Map();
    this.writeInterval = null;

    // Stale check interval
    this.staleCheckInterval = null;

    // Soft-delete grace period tracking: eventId → setTimeout handle
    this.deletedGraceTimers = new Map();
  }

  init(io) {
    if (!API_KEY) {
      console.error("[OddsApiLive] ❌ Missing ODDS_API_KEY in environment");
      return;
    }

    this.io = io;
    this.writeInterval = setInterval(() => this.flushWriteQueue(), 1000);
    this.staleCheckInterval = setInterval(() => this.checkStaleOdds(), 20000);
    this.restPollInterval = setInterval(() => this.pollLinkedFixtures(), 30000); // 30s — REST poll interval for live matches
    this.upcomingPollInterval = setInterval(
      () => this.pollUpcomingFixtures(),
      5 * 60 * 1000,
    );

    console.log("[OddsApiLive] 🚀 Initializing odds-api.io v3 integration...");
    this.connect();
    this.recoverLinkedFixtures();
  }

  connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;
    console.log("[OddsApiLive] 🔌 Connecting to WebSocket...");
    try {
      this.ws = new WebSocket(WS_BASE_URL, { handshakeTimeout: 10000 });
    } catch (err) {
      console.error("[OddsApiLive] ❌ WebSocket creation failed:", err.message);
      this.isConnecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[OddsApiLive] ✅ WebSocket connected. Authenticating...");
      this.isConnecting = false;
      const loginPayload = {
        type: "login",
        apiKey: API_KEY,
        channels: ["fixtures", "odds", "scores", "status"],
        sportIds: [27],
        bookmakers: ["pinnacle", "betfair-ex"],
        receiveType: "json",
      };
      if (this.lastSeq) loginPayload.serverEpoch = this.lastSeq;
      this.ws.send(JSON.stringify(loginPayload));
    });

    this.ws.on("message", (raw) => {
      try {
        const str = raw.toString();
        const lines = str.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            this.handleMessage(msg);
          } catch (err) {
            console.error("[OddsApiLive] ❌ Message parse error:", err.message);
          }
        }
      } catch (err) {}
    });

    this.ws.on("close", (code) => {
      this.isConnecting = false;
      console.warn("[OddsApiLive] ⚠️ WebSocket closed (code: " + code + ")");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.isConnecting = false;
      console.error("[OddsApiLive] ❌ WebSocket error:", err.message);
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      Math.pow(2, this.reconnectAttempts) * 1000,
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;

    console.log(
      `[OddsApiLive] 🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  handleMessage(msg) {
    if (msg.serverEpoch) this.lastSeq = msg.serverEpoch;
    const type = msg.type || msg.channel;
    switch (type) {
      case "login_ok":
        this.reconnectAttempts = 0;
        console.log(
          "[OddsApiLive] ✅ Received login_ok. Triggering bootstrap...",
        );
        this.bootstrapUpcomingFixtures();
        break;
      case "odds":
        this.handleOddsData(msg);
        break;
      case "fixtures":
        this.storeFixtureMetadata(msg.payload || msg);
        break;
      case "deleted":
        this.handleDeleted(msg.payload || msg);
        break;
      case "scores":
        this.handleScoreUpdate(msg.payload || msg);
        break;
      case "status":
        this.handleStatusUpdate(msg.payload || msg);
        break;
      case "snapshot_required":
        console.warn("[OddsApiLive] 🔄 Resync required.");
        this.lastSeq = null;
        if (this.ws) this.ws.close();
        break;
    }
  }

  async bootstrapUpcomingFixtures() {
    console.log("[OddsApiLive] 📅 Bootstrapping upcoming + live fixtures...");
    try {
      // ✅ FIX 1: Include LIVE matches in bootstrap — not just upcoming.
      // When server restarts mid-match, live matches are already status='live' in DB
      // and were never bootstrapped, so they never get linked to an oddsApi eventId.
      const activeMatches = await Match.find({
        status: { $in: ["upcoming", "live"] },
      });
      if (activeMatches.length === 0) return;

      const datesToFetch = new Set();
      for (let i = 0; i <= 2; i++) {
        const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
        datesToFetch.add(d.toISOString().split("T")[0]);
      }
      // Add start dates of all active matches to ensure we don't miss Test matches that started days ago
      for (const match of activeMatches) {
        if (match.startTime) {
          const d = new Date(match.startTime);
          datesToFetch.add(d.toISOString().split("T")[0]);
        }
      }
      const dates = Array.from(datesToFetch);

      // Also try live fixtures endpoint to capture in-play events
      let liveFixtures = [];
      try {
        const liveData = await oddsApiRest.getFixturesLive();
        if (liveData && Array.isArray(liveData)) liveFixtures = liveData;
      } catch (err) {
        console.warn(
          "[OddsApiLive] ⚠️ Could not fetch live fixtures:",
          err.message,
        );
      }

      let totalLinked = 0;

      // Process live fixtures first (highest priority)
      for (const fixture of liveFixtures) {
        if (!shouldIncludeFixture(fixture)) continue;
        this.storeFixtureMetadata(fixture);
        const matchId = await this.linkEventToMatch(
          fixture.fixtureId || fixture.id,
        );
        if (matchId) {
          totalLinked++;
          try {
            const oddsData = await oddsApiRest.getFixtureOdds(
              fixture.fixtureId || fixture.id,
              BOOKMAKERS,
            );
            if (oddsData) {
              const dataArray = Array.isArray(oddsData) ? oddsData : [oddsData];
              for (const odd of dataArray) {
                await this.processOddsForEvent(odd);
              }
            }
          } catch (err) {}
        }
      }

      // Process date-based upcoming fixtures
      for (const dateStr of dates) {
        try {
          const fixtures = await oddsApiRest.getFixturesForDate(dateStr);
          if (fixtures && Array.isArray(fixtures)) {
            for (const fixture of fixtures) {
              if (!shouldIncludeFixture(fixture)) continue;
              this.storeFixtureMetadata(fixture);
              const matchId = await this.linkEventToMatch(
                fixture.fixtureId || fixture.id,
              );
              if (matchId) {
                totalLinked++;
                try {
                  const oddsData = await oddsApiRest.getFixtureOdds(
                    fixture.fixtureId || fixture.id,
                    BOOKMAKERS,
                  );
                  if (oddsData) {
                    const dataArray = Array.isArray(oddsData)
                      ? oddsData
                      : [oddsData];
                    for (const odd of dataArray) {
                      await this.processOddsForEvent(odd);
                    }
                  }
                } catch (err) {}
              }
            }
          }
        } catch (err) {}
      }
      // Log any active DB matches that still couldn't be linked (not on this API)
      const linkedMatchIds = new Set(
        Array.from(this.eventToMatchId.values()).map(String),
      );
      const unlinkedActive = activeMatches.filter(
        (m) => !linkedMatchIds.has(String(m.matchId)),
      );
      if (unlinkedActive.length > 0) {
        console.warn(
          `[OddsApiLive] ⚠️ ${unlinkedActive.length} match(es) NOT found on odds API (no odds coverage):`,
          unlinkedActive
            .map((m) => `${m.teamA} v ${m.teamB} [${m.status}]`)
            .join(", "),
        );
      }
      console.log(
        `[OddsApiLive] 📅 Bootstrap complete: ${totalLinked} fixtures linked.`,
      );
    } catch (err) {
      console.error("[OddsApiLive] ❌ Bootstrap failed:", err.message);
    }
  }

  async recoverLinkedFixtures() {
    try {
      const activeMatches = await Match.find({
        status: { $in: ["live", "upcoming"] },
      });
      if (activeMatches.length === 0) return;

      const marketOdds = await MarketOdds.find({
        matchId: { $in: activeMatches.map((m) => m.matchId) },
        oddsApiEventId: { $exists: true, $ne: "" },
      });

      let recovered = 0;
      for (const mo of marketOdds) {
        const eventId = mo.oddsApiEventId;
        if (this.eventToMatchId.has(eventId)) continue;

        try {
          const fixtureData = await oddsApiRest.getFixtures({ id: eventId });
          const fixtures = Array.isArray(fixtureData)
            ? fixtureData
            : [fixtureData];
          const fixture = fixtures.find((f) => f && f.id === eventId);

          if (fixture) {
            this.storeFixtureMetadata(fixture);
            this.eventToMatchId.set(eventId, mo.matchId);

            const oddsData = await oddsApiRest.getFixtureOdds(
              eventId,
              BOOKMAKERS,
            );
            if (oddsData) {
              const dataArray = Array.isArray(oddsData) ? oddsData : [oddsData];
              for (const odd of dataArray) {
                await this.processOddsForEvent(odd);
              }
            }
            recovered++;
          }
        } catch (err) {}
      }
      if (recovered > 0)
        console.log(`[OddsApiLive] 🔄 Recovered ${recovered} fixtures from DB`);
    } catch (err) {}
  }

  storeFixtureMetadata(fixture) {
    if (!fixture) return;
    const eventId = fixture.id || fixture.fixtureId;
    if (!eventId) return;

    const home =
      fixture.participants?.participant1Name ||
      fixture.home_team ||
      fixture.home;
    const away =
      fixture.participants?.participant2Name ||
      fixture.away_team ||
      fixture.away;
    const sport =
      fixture.sport?.sportName || fixture.sport_key || fixture.sport;
    const commenceTime = fixture.startTime
      ? new Date(fixture.startTime * 1000).toISOString()
      : fixture.commence_time;
    const isLive = fixture.status?.live || fixture.status === "live";

    this.eventMetadata.set(eventId, {
      eventId: eventId,
      home: home,
      away: away,
      sport: sport,
      commenceTime: commenceTime,
      isLive: isLive,
    });
  }

  async linkEventToMatch(eventId) {
    if (this.eventToMatchId.has(eventId)) {
      return this.eventToMatchId.get(eventId);
    }

    // Add cooldown to prevent spamming DB for unlinked events
    if (!this.linkCooldown) this.linkCooldown = new Map();
    if (this.linkCooldown.has(eventId)) {
      const lastAttempt = this.linkCooldown.get(eventId);
      if (Date.now() - lastAttempt < 10000) return null; // 10s cooldown — allow faster retry
    }
    this.linkCooldown.set(eventId, Date.now());

    const metadata = this.eventMetadata.get(eventId);
    if (!metadata || !metadata.home || !metadata.away) return null;

    try {
      const matches = await Match.find({
        status: { $in: ["live", "upcoming"] },
      });
      const apiHome = this.normalize(metadata.home);
      const apiAway = this.normalize(metadata.away);
      const apiTime = metadata.commenceTime
        ? new Date(metadata.commenceTime).getTime()
        : 0;

      // Pass 1: Exact normalized match
      for (const match of matches) {
        const dbHome = this.normalize(match.teamA);
        const dbAway = this.normalize(match.teamB);
        const dbTime = new Date(match.startTime).getTime();

        const teamsMatch =
          (dbHome === apiHome && dbAway === apiAway) ||
          (dbHome === apiAway && dbAway === apiHome);

        if (teamsMatch) {
          const timeDiff =
            apiTime > 0 ? Math.abs(dbTime - apiTime) / (1000 * 60 * 60) : 0;
          if (timeDiff <= 12 || apiTime === 0) {
            this.eventToMatchId.set(eventId, match.matchId);
            console.log(
              `[OddsApiLive] 🔗 Linked ${metadata.home} v ${metadata.away} → match ${match.matchId}`,
            );
            return match.matchId;
          }
        }
      }

      // Pass 2: Substring fallback — if normalized names are contained within each other
      for (const match of matches) {
        const dbHome = this.normalize(match.teamA);
        const dbAway = this.normalize(match.teamB);
        const dbTime = new Date(match.startTime).getTime();

        const homeContains =
          (dbHome.includes(apiHome) || apiHome.includes(dbHome)) &&
          dbHome.length >= 3 &&
          apiHome.length >= 3;
        const awayContains =
          (dbAway.includes(apiAway) || apiAway.includes(dbAway)) &&
          dbAway.length >= 3 &&
          apiAway.length >= 3;
        const homeContainsSwap =
          (dbHome.includes(apiAway) || apiAway.includes(dbHome)) &&
          dbHome.length >= 3 &&
          apiAway.length >= 3;
        const awayContainsSwap =
          (dbAway.includes(apiHome) || apiHome.includes(dbAway)) &&
          dbAway.length >= 3 &&
          apiHome.length >= 3;

        const teamsMatch =
          (homeContains && awayContains) ||
          (homeContainsSwap && awayContainsSwap);

        if (teamsMatch) {
          const timeDiff =
            apiTime > 0 ? Math.abs(dbTime - apiTime) / (1000 * 60 * 60) : 0;
          if (timeDiff <= 12 || apiTime === 0) {
            this.eventToMatchId.set(eventId, match.matchId);
            console.log(
              `[OddsApiLive] 🔗 Linked (fuzzy) ${metadata.home} v ${metadata.away} → match ${match.matchId}`,
            );
            return match.matchId;
          }
        }
      }
    } catch (err) {
      console.error(
        `[OddsApiLive] ❌ Event linking error for ${eventId}:`,
        err.message,
      );
    }
    return null;
  }

  normalize(name) {
    if (!name) return "";
    let n = name.toLowerCase().trim();
    n = n
      .replace(/\bwomen\b/g, "")
      .replace(/\bteam\b/g, "")
      .replace(/\bcricket\b/g, "")
      .replace(/\bnational\b/g, "")
      .replace(/\bmen\b/g, "")
      .replace(/\bxi\b/g, "");
    n = n.replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "");

    const aliases = {
      // IPL Teams
      royalchallengers: "rcb",
      bengaluru: "rcb",
      bangalore: "rcb",
      lucknowsupergiants: "lsg",
      lucknow: "lsg",
      sunrisershyderabad: "srh",
      sunrisers: "srh",
      mumbaiindians: "mi",
      chennaisuperkings: "csk",
      delhicapitals: "dc",
      rajasthanroyals: "rr",
      gujarattitans: "gt",
      kolkataknightriders: "kkr",
      punjabkings: "pbks",
      kingsxi: "pbks",
      // International Teams
      india: "india",
      bharat: "india",
      australia: "australia",
      aussies: "australia",
      england: "england",
      southafrica: "southafrica",
      proteas: "southafrica",
      newzealand: "newzealand",
      blackcaps: "newzealand",
      pakistan: "pakistan",
      srilanka: "srilanka",
      westindies: "westindies",
      windies: "westindies",
      bangladesh: "bangladesh",
      afghanistan: "afghanistan",
      zimbabwe: "zimbabwe",
      ireland: "ireland",
      scotland: "scotland",
      nepal: "nepal",
      oman: "oman",
      namibia: "namibia",
      unitedstates: "usa",
      usa: "usa",
      netherlands: "netherlands",
      unitedarabemirates: "uae",
      uae: "uae",
      // PSL Teams
      karachikings: "karachikings",
      islamabadunited: "islamabadunited",
      peshaarzalmi: "peshawarzalmi",
      peshawarzalmi: "peshawarzalmi",
      multansultans: "multansultans",
      quettagladiators: "quettagladiators",
      lahoreqalandars: "lahoreqalandars",
    };
    for (const [key, value] of Object.entries(aliases)) {
      if (n.includes(key)) return value;
    }
    return n;
  }

  async handleOddsData(msg) {
    const eventId = msg.payload?.fixtureId || msg.fixtureId || msg.id;
    if (!eventId) return;

    this.storeFixtureMetadata(msg.payload || msg);

    let matchId = this.eventToMatchId.get(eventId);
    if (!matchId) {
      matchId = await this.linkEventToMatch(eventId);
      if (!matchId) return;
    }

    console.log(
      `[OddsApiLive] ⚡ WebSocket odds received for event ${eventId} (match ${matchId})`,
    );
    await this.processOddsForEvent(msg.payload || msg);
  }

  async processOddsForEvent(eventObj) {
    const eventId = eventObj.fixtureId || eventObj.id;
    const matchId = this.eventToMatchId.get(eventId);
    if (!matchId) return;

    const metadata = this.eventMetadata.get(eventId);
    if (!metadata) return;

    let bookiesMap = eventObj.odds || eventObj.bookmakers || {};
    if (eventObj.bookie && eventObj.markets) {
      bookiesMap = { [eventObj.bookie]: eventObj.markets };
    }

    // Normalize flat (REST) vs nested (WebSocket) odds structure
    let normalizedOdds = {};
    for (const [key, val] of Object.entries(bookiesMap)) {
      if (val && typeof val === "object") {
        if (val.bookmaker) {
          // Flat REST style: key is OddsId, val is outcome quote object
          const bk = val.bookmaker;
          if (!normalizedOdds[bk]) {
            normalizedOdds[bk] = {};
          }
          normalizedOdds[bk][key] = val;
        } else {
          // Nested WS style: key is bookmaker, val is outcome map
          normalizedOdds[key] = val;
        }
      }
    }

    let bestHomePrice = 0;
    let bestAwayPrice = 0;
    let homeBack = 0,
      homeBackVol = "0",
      homeLay = 0,
      homeLayVol = "0";
    let awayBack = 0,
      awayBackVol = "0",
      awayLay = 0,
      awayLayVol = "0";
    let usedBookie = "";

    const allowedKeys = Object.keys(normalizedOdds).filter((bkKey) => {
      const norm = bkKey.replace(/-/g, "_");
      return BOOKMAKERS.includes(bkKey) || BOOKMAKERS.includes(norm);
    });

    // Sort keys to prioritize Pinnacle
    allowedKeys.sort((a, b) => {
      const isPinnacleA = a.toLowerCase().includes("pinnacle");
      const isPinnacleB = b.toLowerCase().includes("pinnacle");
      if (isPinnacleA && !isPinnacleB) return -1;
      if (!isPinnacleA && isPinnacleB) return 1;
      return 0;
    });

    for (const bookieKey of allowedKeys) {
      const outcomes = normalizedOdds[bookieKey];
      const isExchange =
        bookieKey.toLowerCase().includes("exchange") ||
        bookieKey.toLowerCase().includes("ex");

      let homeOutcome = null;
      let awayOutcome = null;

      if (Array.isArray(outcomes)) {
        // Standard REST array format: find h2h market
        const h2h = outcomes.find((m) => m.key === "h2h");
        if (h2h && h2h.outcomes && h2h.outcomes.length >= 2) {
          homeOutcome = h2h.outcomes[0];
          awayOutcome = h2h.outcomes[1];
        }
      } else {
        const quoteList = Object.values(outcomes).filter(
          (q) => q && q.active !== false,
        );

        // Group by marketId to find h2h market (2 outcomes)
        const byMarket = {};
        for (const q of quoteList) {
          const mid = q.marketId ?? "default";
          if (!byMarket[mid]) byMarket[mid] = [];
          byMarket[mid].push(q);
        }

        // Find a market that has exactly 2 outcomes
        let winnerMarket = null;
        for (const [mId, grp] of Object.entries(byMarket)) {
          if (grp.length === 2) {
            winnerMarket = grp;
            break;
          }
        }

        if (winnerMarket) {
          winnerMarket.sort((a, b) => (a.outcomeId || 0) - (b.outcomeId || 0));
          homeOutcome = winnerMarket[0];
          awayOutcome = winnerMarket[1];
        }
      }

      if (
        homeOutcome &&
        awayOutcome &&
        homeOutcome.price &&
        awayOutcome.price
      ) {
        // Staleness check: Skip if quote is stale
        let changedAt =
          homeOutcome.changedAt ||
          homeOutcome.changed_at ||
          homeOutcome.updatedAt ||
          homeOutcome.updated_at;
        if (changedAt) {
          const parsedTime =
            typeof changedAt === "string"
              ? new Date(changedAt).getTime()
              : Number(changedAt);
          if (!isNaN(parsedTime) && parsedTime > 0) {
            const quoteAgeMs = Date.now() - parsedTime;
            const isLive = metadata.isLive;
            const maxAgeMs = isLive ? 60 * 1000 : 30 * 60 * 1000; // 60 seconds if live, 30 minutes if pre-match

            if (quoteAgeMs > maxAgeMs) {
              console.log(
                `[OddsApiLive] ⚠️ Skipping bookmaker '${bookieKey}' for event ${eventId} due to stale quotes (age: ${Math.round(quoteAgeMs / 1000 / 60)} minutes)`,
              );
              continue;
            }
          }
        }

        usedBookie = bookieKey;

        // Extract back/lay/size for home
        if (isExchange && homeOutcome.meta) {
          homeBack =
            homeOutcome.meta.availableToBack?.[0]?.price ||
            homeOutcome.price ||
            0;
          homeBackVol =
            homeOutcome.meta.availableToBack?.[0]?.size !== undefined
              ? Math.round(homeOutcome.meta.availableToBack[0].size).toString()
              : "100";
          homeLay =
            homeOutcome.meta.availableToLay?.[0]?.price ||
            Number((homeBack + 0.02).toFixed(2));
          homeLayVol =
            homeOutcome.meta.availableToLay?.[0]?.size !== undefined
              ? Math.round(homeOutcome.meta.availableToLay[0].size).toString()
              : "100";
        } else {
          homeBack = homeOutcome.price;
          homeBackVol =
            homeOutcome.limit !== undefined
              ? Math.round(homeOutcome.limit).toString()
              : "500";
          homeLay = Number((homeBack + 0.01).toFixed(2));
          homeLayVol = "500";
        }

        // Extract back/lay/size for away
        if (isExchange && awayOutcome.meta) {
          awayBack =
            awayOutcome.meta.availableToBack?.[0]?.price ||
            awayOutcome.price ||
            0;
          awayBackVol =
            awayOutcome.meta.availableToBack?.[0]?.size !== undefined
              ? Math.round(awayOutcome.meta.availableToBack[0].size).toString()
              : "100";
          awayLay =
            awayOutcome.meta.availableToLay?.[0]?.price ||
            Number((awayBack + 0.02).toFixed(2));
          awayLayVol =
            awayOutcome.meta.availableToLay?.[0]?.size !== undefined
              ? Math.round(awayOutcome.meta.availableToLay[0].size).toString()
              : "100";
        } else {
          awayBack = awayOutcome.price;
          awayBackVol =
            awayOutcome.limit !== undefined
              ? Math.round(awayOutcome.limit).toString()
              : "500";
          awayLay = Number((awayBack + 0.01).toFixed(2));
          awayLayVol = "500";
        }

        bestHomePrice = homeOutcome.price;
        bestAwayPrice = awayOutcome.price;

        // Since allowedKeys is sorted with Pinnacle first, if we successfully set odds from Pinnacle,
        // we break out of the loop and stop checking other bookmakers.
        break;
      }
    }

    if (bestHomePrice === 0 || bestAwayPrice === 0) return;

    let needsSwap = false;
    if (this.swapCache.has(matchId)) {
      needsSwap = this.swapCache.get(matchId);
    } else {
      try {
        const dbMatch = await Match.findOne({ matchId });
        if (dbMatch) {
          const dbTeamA = this.normalize(dbMatch.teamA);
          const apiHome = this.normalize(metadata.home);
          const apiAway = this.normalize(metadata.away);

          if (dbTeamA === apiAway && dbTeamA !== apiHome) {
            needsSwap = true;
          }
        }
        // Cache the swap decision so we don't hit the DB again for this match
        this.swapCache.set(matchId, needsSwap);
      } catch (err) {}
    }

    const teamABack = needsSwap ? awayBack : homeBack;
    const teamALay = needsSwap ? awayLay : homeLay;
    const teamBBack = needsSwap ? homeBack : awayBack;
    const teamBLay = needsSwap ? homeLay : awayLay;

    const depthBackA = needsSwap ? awayBackVol : homeBackVol;
    const depthLayA = needsSwap ? awayLayVol : homeLayVol;
    const depthBackB = needsSwap ? homeBackVol : awayBackVol;
    const depthLayB = needsSwap ? homeLayVol : awayLayVol;

    const now = new Date();
    const oddsPayload = {
      matchId,
      teamABack,
      teamALay,
      teamBBack,
      teamBLay,
      depthBackA,
      depthLayA,
      depthBackB,
      depthLayB,
      bookmaker: usedBookie,
      isLive: metadata.isLive,
      updatedAt: now,
    };

    const cached = this.oddsCache.get(matchId);
    const changed =
      !cached ||
      cached.teamABack !== oddsPayload.teamABack ||
      cached.teamALay !== oddsPayload.teamALay ||
      cached.teamBBack !== oddsPayload.teamBBack ||
      cached.teamBLay !== oddsPayload.teamBLay;

    if (!changed) return;

    this.oddsCache.set(matchId, oddsPayload);

    // ✅ AUTO-RECOVERY: Cancel any pending soft-delete grace timer for this event
    if (this.deletedGraceTimers.has(eventId)) {
      clearTimeout(this.deletedGraceTimers.get(eventId));
      this.deletedGraceTimers.delete(eventId);
      console.log(
        `[OddsApiLive] ♻️ Cancelled grace-period suspension for event ${eventId} — fresh odds received`,
      );
    }

    const dbTeamAName = needsSwap ? metadata.away : metadata.home;
    const dbTeamBName = needsSwap ? metadata.home : metadata.away;

    if (this.io) {
      // Emit matchId as BOTH number and string so the frontend
      // comparison works regardless of the type stored in cricketMatches.
      console.log(
        `[OddsApiLive] 📡 Emitting odds update to UI for match ${matchId} (${dbTeamAName} v ${dbTeamBName}) | Bookmaker: ${usedBookie} | Odds: A(${teamABack}/${teamALay}) B(${teamBBack}/${teamBLay})`,
      );
      this.io.emit("market_odds_update", {
        matchId: String(matchId), // string for frontend Map lookup
        matchIdNum: Number(matchId), // number for legacy listeners
        updatedAt: now,
        marketStatus: "OPEN",
        runners: [
          {
            name: dbTeamAName,
            back: teamABack,
            lay: teamALay,
            depthBack: depthBackA,
            depthLay: depthLayA,
          },
          {
            name: dbTeamBName,
            back: teamBBack,
            lay: teamBLay,
            depthBack: depthBackB,
            depthLay: depthLayB,
          },
        ],
      });
    }

    this.writeQueue.set(matchId, {
      ...oddsPayload,
      oddsApiEventId: eventId,
      teamA: dbTeamAName,
      teamB: dbTeamBName,
      marketStatus: "OPEN",
    });
  }

  async handleDeleted(msg) {
    const eventId = msg.fixtureId || msg.id;
    if (!eventId) return;
    const matchId = this.eventToMatchId.get(eventId);
    if (!matchId) return;

    // ✅ SOFT-DELETE: Use a 2-minute grace period instead of immediate suspension.
    // OddsPapi may send 'deleted' during market recalculation or temporary pauses.
    // If fresh odds arrive within the grace period, the timer is cancelled in processOddsForEvent().
    if (this.deletedGraceTimers.has(eventId)) {
      // Already waiting — don't stack timers
      return;
    }

    console.log(
      `[OddsApiLive] ⏳ Event ${eventId} (match ${matchId}) received 'deleted' — starting 2-min grace period`,
    );

    const timer = setTimeout(
      async () => {
        this.deletedGraceTimers.delete(eventId);
        console.log(
          `[OddsApiLive] ⛔ Grace period expired for event ${eventId} (match ${matchId}) — suspending market`,
        );
        if (this.io) {
          this.io.emit("market_odds_update", {
            matchId: String(matchId),
            marketStatus: "SUSPENDED",
          });
        }
        await this.updateMarketStatus(matchId, "SUSPENDED");
        // Don't remove the event mapping — allow re-linking if the event comes back
      },
      2 * 60 * 1000,
    ); // 2 minutes

    this.deletedGraceTimers.set(eventId, timer);
  }

  handleScoreUpdate(msg) {
    // Implement if required
  }

  handleStatusUpdate(msg) {
    const eventId = msg.fixtureId || msg.id;
    if (!eventId) return;
    const matchId = this.eventToMatchId.get(eventId);
    if (!matchId) return;

    const metadata = this.eventMetadata.get(eventId);
    if (metadata) {
      metadata.isLive = msg.status === "live";
    }
  }

  async updateMarketStatus(matchId, status) {
    try {
      await MarketOdds.findOneAndUpdate(
        { matchId },
        { marketStatus: status, updatedAt: new Date() },
      );
      await Match.findOneAndUpdate(
        { matchId },
        { marketStatus: status, lastUpdated: new Date() },
      );
    } catch (err) {}
  }

  async flushWriteQueue() {
    if (this.writeQueue.size === 0) return;
    const updates = Array.from(this.writeQueue.values());
    this.writeQueue.clear();

    const marketOddsOps = updates.map((update) => ({
      updateOne: {
        filter: { matchId: update.matchId },
        update: {
          $set: {
            matchId: update.matchId,
            oddsApiEventId: update.oddsApiEventId || "",
            teamA: { back: update.teamABack, lay: update.teamALay },
            teamB: { back: update.teamBBack, lay: update.teamBLay },
            bookmaker: update.bookmaker,
            marketStatus: update.marketStatus,
            updatedAt: update.updatedAt,
          },
        },
        upsert: true,
      },
    }));

    const oddsMarketOps = updates.map((update) => ({
      updateOne: {
        filter: { dbMatchId: update.matchId },
        update: {
          $set: {
            dbMatchId: update.matchId,
            oddsApiEventId: update.oddsApiEventId || "",
            teamA: update.teamA,
            teamB: update.teamB,
            teamABack: update.teamABack,
            teamALay: update.teamALay,
            teamBBack: update.teamBBack,
            teamBLay: update.teamBLay,
            bookmaker: update.bookmaker,
            marketStatus: update.marketStatus,
            isLive: update.isLive,
            updatedAt: update.updatedAt,
          },
        },
        upsert: true,
      },
    }));

    const matchOps = updates.map((update) => ({
      updateOne: {
        filter: { matchId: update.matchId },
        update: {
          $set: {
            backOddsA: update.teamABack,
            layOddsA: update.teamALay,
            backOddsB: update.teamBBack,
            layOddsB: update.teamBLay,
            depthBackA: update.depthBackA,
            depthLayA: update.depthLayA,
            depthBackB: update.depthBackB,
            depthLayB: update.depthLayB,
            marketStatus: "OPEN",
            lastUpdated: update.updatedAt,
          },
        },
      },
    }));

    try {
      if (marketOddsOps.length > 0) await MarketOdds.bulkWrite(marketOddsOps);
      if (oddsMarketOps.length > 0) await OddsMarket.bulkWrite(oddsMarketOps);
      if (matchOps.length > 0) await Match.bulkWrite(matchOps);
    } catch (err) {
      console.error("[OddsApiLive] Bulk write error:", err.message);
    }
  }

  async checkStaleOdds() {
    try {
      const staleTime = new Date(Date.now() - STALE_TIMEOUT_MS);
      const staleMarkets = await MarketOdds.find({
        updatedAt: { $lt: staleTime },
        marketStatus: "OPEN",
      });

      for (const market of staleMarkets) {
        const match = await Match.findOne({ matchId: market.matchId });
        if (match && match.status === "live") {
          await this.updateMarketStatus(market.matchId, "SUSPENDED");
          if (this.io) {
            this.io.emit("market_odds_update", {
              matchId: String(market.matchId),
              marketStatus: "SUSPENDED",
            });
          }
        }
      }
    } catch (err) {}
  }

  async pollLinkedFixtures() {
    try {
      const liveMatches = await Match.find({ status: "live" });
      if (liveMatches.length === 0) return;

      const linkedMatchIds = new Set(
        Array.from(this.eventToMatchId.values()).map(String),
      );
      const unlinkedLive = liveMatches.filter(
        (m) => !linkedMatchIds.has(String(m.matchId)),
      );

      // ✅ If live matches exist that are not yet linked, re-run bootstrap — but with
      // a 5-minute cooldown to avoid hammering the API for matches it simply doesn't cover.
      if (unlinkedLive.length > 0) {
        if (!this.lastBootstrapAttempt) this.lastBootstrapAttempt = 0;
        const msSinceLastBootstrap = Date.now() - this.lastBootstrapAttempt;
        if (msSinceLastBootstrap > 5 * 60 * 1000) {
          // 5 minutes
          this.lastBootstrapAttempt = Date.now();
          console.log(
            `[OddsApiLive] 🔄 Found ${unlinkedLive.length} unlinked live match(es). Re-bootstrapping...`,
          );
          this.bootstrapUpcomingFixtures().catch(() => {});
        }
      }

      for (const [eventId, matchId] of this.eventToMatchId.entries()) {
        const isLive = liveMatches.some(
          (m) => String(m.matchId) === String(matchId),
        );
        if (!isLive) continue;

        try {
          console.log(
            `[OddsApiLive] 🔄 Polling REST live odds for event ${eventId} (match ${matchId})...`,
          );
          const oddsData = await oddsApiRest.getFixtureOdds(
            eventId,
            BOOKMAKERS,
          );
          if (oddsData) {
            console.log(
              `[OddsApiLive] ✅ REST live odds successfully fetched for event ${eventId}`,
            );
            const dataArray = Array.isArray(oddsData) ? oddsData : [oddsData];
            for (const odd of dataArray) {
              await this.processOddsForEvent(odd);
            }
          }
        } catch (err) {
          console.error(
            `[OddsApiLive] ❌ REST live poll failed for event ${eventId}:`,
            err.message,
          );
        }
      }
    } catch (err) {}
  }

  async pollUpcomingFixtures() {
    try {
      const upcomingMatches = await Match.find({ status: "upcoming" });
      if (upcomingMatches.length === 0) return;

      const upcomingMatchIds = new Set(upcomingMatches.map((m) => m.matchId));
      for (const [eventId, matchId] of this.eventToMatchId.entries()) {
        if (!upcomingMatchIds.has(matchId)) continue;

        try {
          console.log(
            `[OddsApiLive] 🔄 Polling REST upcoming odds for event ${eventId} (match ${matchId})...`,
          );
          const oddsData = await oddsApiRest.getFixtureOdds(
            eventId,
            BOOKMAKERS,
          );
          if (oddsData) {
            console.log(
              `[OddsApiLive] ✅ REST upcoming odds successfully fetched for event ${eventId}`,
            );
            const dataArray = Array.isArray(oddsData) ? oddsData : [oddsData];
            for (const odd of dataArray) {
              await this.processOddsForEvent(odd);
            }
          }
        } catch (err) {
          console.error(
            `[OddsApiLive] ❌ REST upcoming poll failed for event ${eventId}:`,
            err.message,
          );
        }
      }

      const unlinkedUpcoming = upcomingMatches.filter(
        (m) => !Array.from(this.eventToMatchId.values()).includes(m.matchId),
      );
      if (unlinkedUpcoming.length > 0) {
        await this.bootstrapUpcomingFixtures();
      }
    } catch (err) {}
  }

  async fetchOddsSnapshot() {
    console.log("[OddsApiLive] 📸 Fetching odds snapshot via REST...");
    try {
      const fixtures = await oddsApiRest.getFixturesToday();
      if (fixtures && Array.isArray(fixtures)) {
        for (const fixture of fixtures) {
          if (!shouldIncludeFixture(fixture)) continue;
          if (fixture.fixtureId || fixture.id) {
            this.storeFixtureMetadata(fixture);
            try {
              const oddsData = await oddsApiRest.getFixtureOdds(
                fixture.fixtureId || fixture.id,
                BOOKMAKERS,
              );
              if (oddsData) {
                const dataArray = Array.isArray(oddsData)
                  ? oddsData
                  : [oddsData];
                for (const odd of dataArray) {
                  await this.processOddsForEvent(odd);
                }
              }
            } catch (err) {}
          }
        }
      }
    } catch (err) {
      console.error("[OddsApiLive] ❌ REST snapshot failed:", err.message);
    }
  }

  destroy() {
    if (this.writeInterval) clearInterval(this.writeInterval);
    if (this.staleCheckInterval) clearInterval(this.staleCheckInterval);
    if (this.restPollInterval) clearInterval(this.restPollInterval);
    if (this.upcomingPollInterval) clearInterval(this.upcomingPollInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // Clear all soft-delete grace timers
    for (const timer of this.deletedGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.deletedGraceTimers.clear();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
  }
}

module.exports = new OddsApiLiveService();
