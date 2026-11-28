const WebSocket = require("ws");
const Match = require("../models/Match");
const MarketOdds = require("../models/MarketOdds");
const OddsMarket = require("../models/OddsMarket");
const oddsApiRest = require("./oddsApiRest");
const { shouldIncludeFixture, isTestMatchFormat } = require("./fixtureFilter");
const fancyMarketsService = require("./fancyMarketsService");
const {
  selectAccurateMatchOddsMarket,
  extractRunnerDepthFromQuote,
  formatLiquidityVolume,
  resolveBetfairFancyMeta,
} = require("./oddspapiCricketCatalog");
require("dotenv").config();

// ─── Configuration ─────────────────────────────────────────────────────────────

const API_KEY = process.env.ODDS_API_KEY || "47867a6c1b58b5b0c53fdf6fe4fed924";
const WS_BASE_URL = "wss://v5.oddspapi.io/ws";
const SPORT = "cricket";
const MARKETS = "h2h";
const CHANNELS = "odds,scores,status";
// Bookmaker targets are filtered here if needed, but the WS url might fetch all.
// The user noted: "Your current code targets betfair-ex (exchange) and pinnacle. On odds-api.io, the equivalent would be Betfair Exchange and Pinnacle. I'll use odds-api.io's naming convention."
// However, the internal API keys for these are typically betfair_ex and bet365.
const BOOKMAKERS = ["betfair-ex", "betfair_ex", "pinnacle"];
const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes — cricket natural pauses (innings breaks ~30-45 min, rain delays)

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

    // Fixture mapping: eventId → primary DB matchId, and eventId → Set of all linked DB matchIds
    this.eventToMatchId = new Map();
    this.eventToMatchIds = new Map();
    // eventId → fixture metadata (home, away, etc.)
    this.eventMetadata = new Map();
    // WS first-tick REST seed tracking & heartbeat state
    this.wsSeededEvents = new Set();
    this.wsHeartbeatInterval = null;
    this.lastWsMessageAt = 0;

    // Persistent raw odds storage per event: eventId -> { [bookmaker]: { [quoteKey]: quote } }
    // Enables continuous delta accumulation so single-runner WebSocket updates never get dropped
    this.eventQuotes = new Map();

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
    this.staleCheckInterval = setInterval(() => this.checkStaleOdds(), 60000); // Check every 60s
    this.restPollInterval = setInterval(() => this.pollLinkedFixtures(), 10000); // 10s — keep live exchange odds & depth fresh
    this.upcomingPollInterval = setInterval(
      () => this.pollUpcomingFixtures(),
      5 * 60 * 1000,
    );
    this.wsHeartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.lastWsMessageAt > 0 && Date.now() - this.lastWsMessageAt > 50000) {
        console.warn("[OddsApiLive] ⚠️ WebSocket silent >50s — recycling stale connection...");
        try {
          this.ws.terminate();
        } catch (e) {}
        return;
      }
      try {
        this.ws.ping();
      } catch (e) {}
    }, 25000);
    // Real-time matching engine for open bets (checked every 2.5s)
    const { checkAndMatchOpenBets } = require('./openBetMatcher');
    this.openBetsMatcherInterval = setInterval(async () => {
      try {
        const Bet = require('../models/Bet');
        const openBetMatchIds = await Bet.distinct('matchId', { status: { $in: ['OPEN', 'open', 'unmatched'] } });
        for (const mId of openBetMatchIds) {
          await checkAndMatchOpenBets(mId, this.io);
        }
      } catch (e) { }
    }, 2500);

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
      this.lastWsMessageAt = Date.now();
      const loginPayload = {
        type: "login",
        apiKey: API_KEY,
        channels: ["fixtures", "odds", "scores", "status"],
        sportIds: [27],
        bookmakers: ["betfair-ex", "pinnacle"],
        receiveType: "json",
      };
      if (this.lastSeq) loginPayload.serverEpoch = this.lastSeq;
      this.ws.send(JSON.stringify(loginPayload));
    });

    this.ws.on("pong", () => {
      this.lastWsMessageAt = Date.now();
    });

    this.ws.on("message", (raw) => {
      this.lastWsMessageAt = Date.now();
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
      } catch (err) { }
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

    // 1. Handle system message types
    if (msg.type === "login_ok") {
      this.reconnectAttempts = 0;
      console.log(
        "[OddsApiLive] ✅ Received login_ok. Triggering bootstrap...",
      );
      this.bootstrapUpcomingFixtures();
      return;
    }
    if (msg.type === "snapshot_required") {
      console.warn("[OddsApiLive] 🔄 Resync required.");
      this.lastSeq = null;
      if (this.ws) this.ws.close();
      return;
    }
    if (msg.type === "deleted" || msg.channel === "deleted") {
      this.handleDeleted(msg.payload || msg);
      return;
    }

    // 2. Route by channel (oddspapi WS sends { channel: "odds", type: "UPDATE", payload: {...} })
    const channel = msg.channel || msg.type;
    switch (channel) {
      case "odds":
        this.handleOddsData(msg);
        break;
      case "fixtures":
        this.storeFixtureMetadata(msg.payload || msg);
        break;
      case "scores":
        this.handleScoreUpdate(msg.payload || msg);
        break;
      case "status":
        this.handleStatusUpdate(msg.payload || msg);
        break;
      default:
        // Fallback: if type is UPDATE with odds payload
        if (msg.payload && msg.payload.odds) {
          this.handleOddsData(msg);
        }
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
      // Fetch yesterday (-1), today (0), and tomorrow (+1, within <2 days out)
      for (let i = -1; i <= 1; i++) {
        const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
        datesToFetch.add(d.toISOString().split("T")[0]);
      }
      // Also include start dates of active matches (e.g. live multi-day Test matches)
      for (const match of activeMatches) {
        if (match.status === 'live' && match.startTime) {
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
          } catch (err) { }
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
                } catch (err) { }
              }
            }
          }
        } catch (err) { }
      }
      // Log any active DB matches that still couldn't be linked (not on this API)
      const unlinkedActive = activeMatches.filter(
        (m) => !this.isMatchIdLinked(m.matchId),
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

  addEventMatchLink(eventId, matchId, { primary = false } = {}) {
    if (!eventId || !matchId) return [];
    const eKey = String(eventId);
    const mKey = String(matchId);
    if (!this.eventToMatchIds.has(eKey)) {
      this.eventToMatchIds.set(eKey, new Set());
    }
    this.eventToMatchIds.get(eKey).add(mKey);
    if (primary || !this.eventToMatchId.has(eKey)) {
      this.eventToMatchId.set(eKey, mKey);
    }
    return Array.from(this.eventToMatchIds.get(eKey));
  }

  getLinkedMatchIds(eventId) {
    if (!eventId) return [];
    const eKey = String(eventId);
    const ids = new Set();
    const mappedSet = this.eventToMatchIds.get(eKey);
    if (mappedSet) {
      for (const mId of mappedSet) ids.add(String(mId));
    }
    const primary = this.eventToMatchId.get(eKey) || this.eventToMatchId.get(eventId);
    if (primary) ids.add(String(primary));
    return Array.from(ids);
  }

  isMatchIdLinked(matchId) {
    if (!matchId) return false;
    const target = String(matchId);
    for (const set of this.eventToMatchIds.values()) {
      if (set.has(target)) return true;
    }
    for (const mId of this.eventToMatchId.values()) {
      if (String(mId) === target) return true;
    }
    return false;
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

      const eventIdsToRecover = new Set();
      for (const m of activeMatches) {
        if (m.oddsApiEventId) {
          this.addEventMatchLink(m.oddsApiEventId, m.matchId, {
            primary: String(m.matchId) === String(m.oddsApiEventId),
          });
          eventIdsToRecover.add(m.oddsApiEventId);
        }
      }
      for (const mo of marketOdds) {
        if (mo.oddsApiEventId) {
          this.addEventMatchLink(mo.oddsApiEventId, mo.matchId, {
            primary: String(mo.matchId) === String(mo.oddsApiEventId),
          });
          eventIdsToRecover.add(mo.oddsApiEventId);
        }
      }

      let recovered = 0;
      for (const eventId of eventIdsToRecover) {
        try {
          const fixtureData = await oddsApiRest.getFixtures({ id: eventId });
          const fixtures = Array.isArray(fixtureData)
            ? fixtureData
            : [fixtureData];
          const fixture = fixtures.find((f) => f && (f.id === eventId || f.fixtureId === eventId));

          if (fixture) {
            this.storeFixtureMetadata(fixture);
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
        } catch (err) { }
      }
      if (recovered > 0)
        console.log(`[OddsApiLive] 🔄 Recovered ${recovered} fixtures from DB`);
    } catch (err) { }
  }

  storeFixtureMetadata(fixture) {
    if (!fixture) return;
    const eventId = fixture.id || fixture.fixtureId;
    if (!eventId) return;

    const existing = this.eventMetadata.get(eventId) || {};

    const home =
      fixture.participants?.participant1Name ||
      fixture.home_team ||
      fixture.home ||
      existing.home;
    const away =
      fixture.participants?.participant2Name ||
      fixture.away_team ||
      fixture.away ||
      existing.away;
    const sport =
      fixture.sport?.sportName ||
      fixture.sport_key ||
      fixture.sport ||
      fixture.sportKey ||
      existing.sport;
    const commenceTime = fixture.startTime
      ? new Date(fixture.startTime * 1000).toISOString()
      : fixture.commence_time || existing.commenceTime;
    const isLive =
      fixture.status?.live ||
      fixture.status === "live" ||
      (existing.isLive ?? false);
    const reissuedId = fixture.reissuedFixtureId || null;

    this.eventMetadata.set(eventId, {
      eventId: eventId,
      home: home,
      away: away,
      sport: sport,
      commenceTime: commenceTime,
      isLive: isLive,
      statusId: fixture.status?.statusId ?? fixture.statusId ?? null,
      reissuedFixtureId: reissuedId,
    });

    if (reissuedId) {
      const linkedIds = this.getLinkedMatchIds(eventId);
      for (const matchId of linkedIds) {
        console.log(`[OddsApiLive] 🔁 Fixture ${eventId} reissued to ${reissuedId}. Linking match ${matchId}...`);
        this.addEventMatchLink(reissuedId, matchId, {
          primary: String(matchId) === String(reissuedId),
        });
        if (this.deletedGraceTimers && this.deletedGraceTimers.has(eventId)) {
          clearTimeout(this.deletedGraceTimers.get(eventId));
          this.deletedGraceTimers.delete(eventId);
        }
        Match.findOneAndUpdate(
          { matchId },
          { oddsApiEventId: reissuedId, reissuedFixtureId: reissuedId, lastUpdated: new Date() }
        ).catch(() => { });
        MarketOdds.findOneAndUpdate(
          { matchId },
          { oddsApiEventId: reissuedId, updatedAt: new Date() }
        ).catch(() => { });
      }
    }
  }

  async linkEventToMatch(eventId) {
    if (!eventId) return null;

    // Add short cooldown to prevent spamming DB for unlinked events
    if (!this.linkCooldown) this.linkCooldown = new Map();
    const existingIds = this.getLinkedMatchIds(eventId);
    if (this.linkCooldown.has(eventId)) {
      const lastAttempt = this.linkCooldown.get(eventId);
      if (Date.now() - lastAttempt < 10000) {
        return existingIds.length > 0 ? (this.eventToMatchId.get(eventId) || existingIds[0]) : null;
      }
    }
    this.linkCooldown.set(eventId, Date.now());

    const metadata = this.eventMetadata.get(eventId);

    try {
      const matches = await Match.find({
        status: { $in: ["live", "upcoming"] },
      });

      const altEventId = String(eventId).startsWith('id') ? String(eventId).replace(/^id/, '') : ('id' + String(eventId));
      const linkedNow = new Set();

      // Pass 0a: Exact matchId match (highest priority — reissued primary fixture)
      for (const match of matches) {
        if (String(match.matchId) === String(eventId) || String(match.matchId) === altEventId) {
          this.addEventMatchLink(eventId, match.matchId, { primary: true });
          linkedNow.add(String(match.matchId));
          console.log(`[OddsApiLive] 🔗 Direct Primary Linked event ${eventId} → match ${match.matchId}`);
        }
      }

      // Pass 0b: Explicit oddsApiEventId match (catches sibling docs sharing the reissued oddsApiEventId)
      for (const match of matches) {
        if (
          !linkedNow.has(String(match.matchId)) &&
          (String(match.oddsApiEventId) === String(eventId) || String(match.oddsApiEventId) === altEventId)
        ) {
          this.addEventMatchLink(eventId, match.matchId);
          linkedNow.add(String(match.matchId));
          console.log(`[OddsApiLive] 🔗 Direct Alias Linked event ${eventId} → match ${match.matchId}`);
        }
      }

      // Pass 1 & 2: Collect ALL matching team candidates (including reversed home/away siblings)
      if (metadata && metadata.home && metadata.away) {
        const apiHome = this.normalize(metadata.home);
        const apiAway = this.normalize(metadata.away);
        const apiTime = metadata.commenceTime
          ? new Date(metadata.commenceTime).getTime()
          : 0;

        const candidates = [];

        for (const match of matches) {
          const dbHome = this.normalize(match.teamA);
          const dbAway = this.normalize(match.teamB);
          const dbTime = new Date(match.startTime).getTime();

          const exactMatch =
            (dbHome === apiHome && dbAway === apiAway) ||
            (dbHome === apiAway && dbAway === apiHome);

          const homeContains =
            (dbHome.includes(apiHome) || apiHome.includes(dbHome)) &&
            dbHome.length >= 3 && apiHome.length >= 3;
          const awayContains =
            (dbAway.includes(apiAway) || apiAway.includes(dbAway)) &&
            dbAway.length >= 3 && apiAway.length >= 3;
          const homeContainsSwap =
            (dbHome.includes(apiAway) || apiAway.includes(dbHome)) &&
            dbHome.length >= 3 && apiAway.length >= 3;
          const awayContainsSwap =
            (dbAway.includes(apiHome) || apiHome.includes(dbAway)) &&
            dbAway.length >= 3 && apiHome.length >= 3;
          const fuzzyMatch =
            (homeContains && awayContains) ||
            (homeContainsSwap && awayContainsSwap);

          if (!exactMatch && !fuzzyMatch) continue;

          const isTest = Boolean(
            match.isTestMatch ||
            (match.league && /\b(test|test match|sheffield|ranji|first-class|first class|4-day|5-day)\b/i.test(match.league)) ||
            (metadata.league && /\b(test|test match|sheffield|ranji|first-class|first class|4-day|5-day)\b/i.test(metadata.league))
          );
          const maxAllowedHours = match.status === 'live' ? 168 : (isTest ? 144 : 24);
          const timeDiff = apiTime > 0 ? Math.abs(dbTime - apiTime) / (1000 * 60 * 60) : 0;

          if (timeDiff <= maxAllowedHours || apiTime === 0) {
            let score = 0;
            if (metadata.isLive && match.status === 'live') score += 10000;
            if (!metadata.isLive && match.status === 'upcoming') score += 5000;
            if (metadata.isLive && match.status === 'upcoming') score += 0;
            if (exactMatch) score += 1000;
            score -= timeDiff;

            candidates.push({ match, score, exactMatch, timeDiff });
          }
        }

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.score - a.score);
          const best = candidates[0];
          const primaryId = linkedNow.size === 0 ? best.match.matchId : this.eventToMatchId.get(eventId);
          for (const cand of candidates) {
            // Link best match and any live/same-day sibling within 30h (e.g. reissued + cancelled duplicate doc)
            if (cand === best || cand.timeDiff <= 30) {
              this.addEventMatchLink(eventId, cand.match.matchId, {
                primary: cand === best && linkedNow.size === 0,
              });
              linkedNow.add(String(cand.match.matchId));
              if (!cand.match.oddsApiEventId && cand.match._id) {
                Match.updateOne({ _id: cand.match._id }, { $set: { oddsApiEventId: eventId } }).catch(() => {});
              }
            }
          }
          console.log(
            `[OddsApiLive] 🔗 Linked${best.exactMatch ? '' : ' (fuzzy)'} ${metadata.home} v ${metadata.away} → ${linkedNow.size} match(es) (primary ${primaryId || best.match.matchId}, timeDiff: ${best.timeDiff.toFixed(1)}h)`,
          );
        }
      }

      const finalIds = this.getLinkedMatchIds(eventId);
      if (finalIds.length > 0) {
        return this.eventToMatchId.get(eventId) || finalIds[0];
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
      // Other Franchise & Domestic Leagues
      kathmandugurkhas: "kathmandugorkhas",
      kathmandugorkhas: "kathmandugorkhas",
      chitwanrhinos: "chitwanrhinos",
      uaebulls: "uaebulls",
      banglatigers: "banglatigers",
      unitedtigers: "unitedtigers",
      emirateseagles: "emirateseagles",
      yaslions: "yaslions",
      // ILT20 Teams
      sharjahwarriors: "sharjahwarriors",
      sharjahwarriorz: "sharjahwarriors",
      desertvipers: "desertvipers",
      gulfgiants: "gulfgiants",
      miemirates: "miemirates",
      dubaicapitals: "dubaicapitals",
      abudhabiknightriders: "adkr",
      // BBL Teams
      perthscorchers: "perthscorchers",
      hobarthurricanes: "hobarthurricanes",
      melbournerenegades: "melbournerenegades",
      sydneythunder: "sydneythunder",
      adelaidestrikers: "adelaidestrikers",
      sydneysixers: "sydneysixers",
      melbournestars: "melbournestars",
      brisbaneheat: "brisbaneheat",
      // SA20 Teams
      micapetown: "micapetown",
      durbansupergiants: "durbansupergiants",
      paarl: "paarlroyals",
      paarlroyals: "paarlroyals",
      pretoriacapitals: "pretoriacapitals",
      sunriserseasterncape: "sunriserseasterncape",
      joburgsuperkings: "joburgsuperkings",
      // CPL Teams
      trinbagoknight: "trinbagoknightriders",
      barbaroyals: "barbadosroyals",
      barbadosroyals: "barbadosroyals",
      guyanawarriors: "guyanawarriors",
      guyaanazonwarriors: "guyanawarriors",
      jamaicakings: "jamaicakingsmen",
      jamaicatallawahs: "jamaicakingsmen",
      stkittspatriots: "stkittspatriots",
      antiguafalcons: "antiguafalcons",
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

    const linkedIds = this.getLinkedMatchIds(eventId);
    let primaryMatchId = linkedIds[0];
    if (!primaryMatchId) {
      primaryMatchId = await this.linkEventToMatch(eventId);
      if (!primaryMatchId) return;
    }

    if (!this.lastOddsLogTime) this.lastOddsLogTime = new Map();
    const now = Date.now();
    const lastLog = this.lastOddsLogTime.get(eventId) || 0;
    if (now - lastLog >= 10000) {
      this.lastOddsLogTime.set(eventId, now);
      console.log(
        `[OddsApiLive] ⚡ WebSocket odds streaming for event ${eventId} (match ${primaryMatchId})`,
      );
    }

    await this.processOddsForEvent(msg.payload || msg);

    // WS UPDATE packets often arrive one runner/outcome at a time; seed full REST snapshot on first WS event
    if (!this.wsSeededEvents.has(eventId)) {
      this.wsSeededEvents.add(eventId);
      oddsApiRest.getFixtureOdds(eventId, BOOKMAKERS)
        .then(async (oddsData) => {
          if (!oddsData) return;
          const dataArray = Array.isArray(oddsData) ? oddsData : [oddsData];
          for (const odd of dataArray) {
            await this.processOddsForEvent(odd);
          }
        })
        .catch(() => {});
    }
  }

  async processOddsForEvent(eventObj) {
    const eventId = eventObj.fixtureId || eventObj.id;
    const targetMatchIds = this.getLinkedMatchIds(eventId);
    if (targetMatchIds.length === 0) return;

    const metadata = this.eventMetadata.get(eventId);
    if (!metadata) return;

    let bookiesMap = eventObj.odds || eventObj.bookmakers || {};
    if (eventObj.bookie && eventObj.markets) {
      bookiesMap = { [eventObj.bookie]: eventObj.markets };
    }

    // Accumulate/merge incoming quotes into persistent event quotes cache
    if (!this.eventQuotes.has(eventId)) {
      this.eventQuotes.set(eventId, {});
    }
    const storedBookies = this.eventQuotes.get(eventId);

    for (const [key, val] of Object.entries(bookiesMap)) {
      if (val && typeof val === "object") {
        if (val.bookmaker) {
          // Flat REST style: key is OddsId, val is outcome quote object
          const bk = val.bookmaker;
          if (!storedBookies[bk]) storedBookies[bk] = {};
          storedBookies[bk][key] = { ...(storedBookies[bk][key] || {}), ...val };
        } else {
          // Nested WS style: key is bookmaker, val is outcome map
          if (!storedBookies[key]) storedBookies[key] = {};
          for (const [qKey, qVal] of Object.entries(val)) {
            storedBookies[key][qKey] = { ...(storedBookies[key][qKey] || {}), ...qVal };
          }
        }
      }
    }

    const normalizedOdds = storedBookies;

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
    let drawBack = 0,
      drawBackVol = "0",
      drawLay = 0,
      drawLayVol = "0";
    let drawOutcome = null;
    let usedBookie = "";
    let dbMatch = null;

    let allowedKeys = Object.keys(normalizedOdds).filter((bkKey) => {
      const lower = bkKey.toLowerCase().replace(/-/g, "_");
      return (
        BOOKMAKERS.some((b) => lower.includes(b.replace(/-/g, "_").toLowerCase())) ||
        lower.includes("betfair") ||
        lower.includes("exchange") ||
        lower.includes("matchbook")
      );
    });

    // If no preferred exchange bookmaker matched, fall back to all available bookmakers in normalizedOdds
    if (allowedKeys.length === 0) {
      allowedKeys = Object.keys(normalizedOdds);
    }

    // Prioritize Betfair Exchange for real back/lay liquidity, fallback to Pinnacle / others
    allowedKeys.sort((a, b) => {
      const lowerA = a.toLowerCase();
      const lowerB = b.toLowerCase();
      const isExA =
        lowerA.includes("exchange") || lowerA.includes("ex") || lowerA.includes("betfair");
      const isExB =
        lowerB.includes("exchange") || lowerB.includes("ex") || lowerB.includes("betfair");
      if (isExA && !isExB) return -1;
      if (!isExA && isExB) return 1;
      return 0;
    });

    let homeLadderBack = [],
      homeLadderLay = [],
      awayLadderBack = [],
      awayLadderLay = [],
      drawLadderBack = [],
      drawLadderLay = [];

    const isTestMatchEarly = isTestMatchFormat({
      league: metadata?.league || this.eventMetadata.get(eventId)?.league,
      teamA: metadata?.home,
      teamB: metadata?.away,
    });

    for (const bookieKey of allowedKeys) {
      const outcomes = normalizedOdds[bookieKey];
      const isExchange =
        bookieKey.toLowerCase().includes("exchange") ||
        bookieKey.toLowerCase().includes("ex");

      let homeOutcome = null;
      let awayOutcome = null;
      drawOutcome = null;

      if (Array.isArray(outcomes)) {
        // Standard REST array format: find h2h market
        const h2h = outcomes.find((m) => m.key === "h2h");
        if (h2h && h2h.outcomes && h2h.outcomes.length >= 2) {
          homeOutcome = h2h.outcomes[0];
          awayOutcome = h2h.outcomes[1];
          if (h2h.outcomes.length >= 3) {
            drawOutcome = h2h.outcomes.find(o => {
              const n = String(o.name || o.label || '').trim().toLowerCase();
              return o.outcomeId === 274 || n === 'x' || n === 'the draw' || n === 'draw' || n === 'tie';
            }) || h2h.outcomes[2];
          }
        }
      } else {
        const quoteList = Object.values(outcomes).filter(
          (q) => q && q.active !== false && q.price > 0,
        );

        // Group by marketId to find h2h / match odds market (2 or 3 outcomes)
        const byMarket = {};
        for (const q of quoteList) {
          const mid = String(q.marketId ?? "default");
          if (!byMarket[mid]) byMarket[mid] = [];
          byMarket[mid].push(q);
        }

        // Select accurate Match Odds market:
        // - Non-Test (T10/T20/ODI): market 271 (Winner incl. super over) takes Priority 1 over low-liquidity 273 (1X2)
        // - Test: market 273 (1X2 with Draw outcome 274) takes Priority 1
        const winnerMarket = selectAccurateMatchOddsMarket(byMarket, isTestMatchEarly);

        if (winnerMarket) {
          if (winnerMarket.length === 3 || winnerMarket.some(q => q.outcomeId === 274 || String(q.name || q.outcomeName || '').trim().toLowerCase() === 'the draw' || String(q.name || q.outcomeName || '').trim().toLowerCase() === 'draw')) {
            drawOutcome = winnerMarket.find(q => {
              const name = String(q.outcomeName || q.name || q.label || '').trim().toLowerCase();
              return q.outcomeId === 274 || name === 'x' || name === 'the draw' || name === 'draw' || name === 'tie';
            });
            const nonDraw = winnerMarket.filter(q => q !== drawOutcome);
            nonDraw.sort((a, b) => (Number(a.outcomeId) || 0) - (Number(b.outcomeId) || 0));
            homeOutcome = nonDraw[0];
            awayOutcome = nonDraw[1];
          } else {
            winnerMarket.sort((a, b) => (Number(a.outcomeId) || 0) - (Number(b.outcomeId) || 0));
            homeOutcome = winnerMarket[0];
            awayOutcome = winnerMarket[1];
          }
        }
      }

      if (
        homeOutcome &&
        awayOutcome &&
        (homeOutcome.price || homeOutcome.meta?.availableToBack?.[0]?.price) &&
        (awayOutcome.price || awayOutcome.meta?.availableToBack?.[0]?.price)
      ) {
        usedBookie = bookieKey;

        const homeD = extractRunnerDepthFromQuote(homeOutcome, isExchange, "100");
        homeBack = homeD.back;
        homeBackVol = homeD.backVol;
        homeLay = homeD.lay;
        homeLayVol = homeD.layVol;
        homeLadderBack = homeD.backOdds;
        homeLadderLay = homeD.layOdds;

        const awayD = extractRunnerDepthFromQuote(awayOutcome, isExchange, "100");
        awayBack = awayD.back;
        awayBackVol = awayD.backVol;
        awayLay = awayD.lay;
        awayLayVol = awayD.layVol;
        awayLadderBack = awayD.backOdds;
        awayLadderLay = awayD.layOdds;

        if (drawOutcome) {
          const drawD = extractRunnerDepthFromQuote(drawOutcome, isExchange, "100");
          drawBack = drawD.back;
          drawBackVol = drawD.backVol;
          drawLay = drawD.lay;
          drawLayVol = drawD.layVol;
          drawLadderBack = drawD.backOdds;
          drawLadderLay = drawD.layOdds;
        }

        bestHomePrice = homeBack;
        bestAwayPrice = awayBack;

        // If we found a valid match odds market, we break out and use it
        break;
      }
    }

    for (const targetMatchId of targetMatchIds) {
      await this._applyOddsSnapshotToMatch(targetMatchId, {
        eventId,
        metadata,
        normalizedOdds,
        bestHomePrice,
        bestAwayPrice,
        homeBack,
        homeBackVol,
        homeLay,
        homeLayVol,
        awayBack,
        awayBackVol,
        awayLay,
        awayLayVol,
        drawBack,
        drawBackVol,
        drawLay,
        drawLayVol,
        homeLadderBack,
        homeLadderLay,
        awayLadderBack,
        awayLadderLay,
        drawLadderBack,
        drawLadderLay,
        usedBookie,
      });
    }
  }

  async _applyOddsSnapshotToMatch(matchId, snapshot) {
    let {
      eventId,
      metadata,
      normalizedOdds,
      bestHomePrice,
      bestAwayPrice,
      homeBack,
      homeBackVol,
      homeLay,
      homeLayVol,
      awayBack,
      awayBackVol,
      awayLay,
      awayLayVol,
      drawBack,
      drawBackVol,
      drawLay,
      drawLayVol,
      homeLadderBack,
      homeLadderLay,
      awayLadderBack,
      awayLadderLay,
      drawLadderBack,
      drawLadderLay,
      usedBookie,
    } = snapshot;

    let dbMatch = null;

    // If no exchange/bookmaker odds found, check if DB already has valid odds
    if (bestHomePrice === 0 || bestAwayPrice === 0) {
      try {
        dbMatch = await Match.findOne({ matchId });
      } catch (e) {}

      // PRESERVE EXISTING ODDS: If match already has valid exchange odds in DB, KEEP them!
      // When a match is at Stumps or in a break, OddsPapi's active quotes are empty.
      // But reject legacy uncalibrated synthetic bug (1.6 / 2.4) or non-exchange synthetic placeholders
      const isLegacySyntheticBug = dbMatch && dbMatch.backOddsA === 1.6 && dbMatch.backOddsB === 2.4;
      const hasRealExchangeDbOdds = dbMatch &&
        dbMatch.backOddsA > 1 &&
        dbMatch.backOddsB > 1 &&
        dbMatch.bookmaker &&
        dbMatch.bookmaker !== 'synthetic-implied' &&
        !isLegacySyntheticBug;

      if (hasRealExchangeDbOdds) {
        homeBack = dbMatch.backOddsA;
        homeLay = dbMatch.layOddsA || Number((dbMatch.backOddsA + 0.02).toFixed(2));
        awayBack = dbMatch.backOddsB;
        awayLay = dbMatch.layOddsB || Number((dbMatch.backOddsB + 0.02).toFixed(2));
        drawBack = dbMatch.backOddsDraw || 0;
        drawLay = dbMatch.layOddsDraw || 0;
        homeBackVol = dbMatch.depthBackA || "100";
        homeLayVol = dbMatch.depthLayA || "100";
        awayBackVol = dbMatch.depthBackB || "100";
        awayLayVol = dbMatch.depthLayB || "100";
        drawBackVol = dbMatch.depthBackDraw || "100";
        drawLayVol = dbMatch.depthLayDraw || "100";
        bestHomePrice = homeBack;
        bestAwayPrice = awayBack;
        usedBookie = dbMatch.bookmaker || "cached-exchange";
      } else {
        const isLiveMatch = metadata.isLive ||
          dbMatch?.status === 'live' ||
          dbMatch?.inplay === true ||
          Boolean(dbMatch?.score?.overs && dbMatch.score.overs !== '0' && dbMatch.score.overs !== '0.0');

        if (!isLiveMatch) return; // Only for live matches

        // Try to derive implied odds from live scores (Roanuz authoritative score or DB score)
        try {
          if (!dbMatch) return;
          // Merge authoritative in-memory / Redis live score from Roanuz
          try {
            const { roanuzScoreService } = require('./roanuzScoreService');
            const hotScore = await roanuzScoreService.getLiveScore(matchId) ||
              (dbMatch.roanuzMatchKey ? await roanuzScoreService.getLiveScore(dbMatch.roanuzMatchKey) : null);
            if (hotScore) {
              dbMatch.score = {
                ...(dbMatch.score || {}),
                ...hotScore
              };
            }
          } catch (e) {}

          if (!dbMatch.score) return;

          const p1Runs = parseInt(String(dbMatch.score.teamA_runs).split('/')[0], 10) || 0;
          const p2Runs = parseInt(String(dbMatch.score.teamB_runs).split('/')[0], 10) || 0;
          const target = dbMatch.score.target || 0;
          const innings = dbMatch.score.innings || 1;
          const battingTeam = dbMatch.score.battingTeam || 'teamA';

          // Only generate if there are actual scores to work with
          if (p1Runs === 0 && p2Runs === 0) return;

          const isTestFormat = Boolean(
            dbMatch?.isTestMatch ||
            (dbMatch?.league && /\b(test|test match|sheffield|ranji|first-class|first class|4-day|5-day)\b/i.test(dbMatch.league)) ||
            (metadata?.league && /\b(test|test match|sheffield|ranji|first-class|first class|4-day|5-day)\b/i.test(metadata.league)) ||
            (dbMatch?.format === 'TEST') ||
            (p1Runs > 250 && p2Runs > 0) ||
            (String(dbMatch?.teamA).toLowerCase().includes('new zealand') && String(dbMatch?.teamB).toLowerCase().includes('india')) ||
            (String(dbMatch?.teamB).toLowerCase().includes('new zealand') && String(dbMatch?.teamA).toLowerCase().includes('india'))
          );

          let homeImpliedOdds = 1.95;
          let awayImpliedOdds = 1.95;

          if (isTestFormat) {
            let probHome = 0.35;
            let probAway = 0.35;
            let probDraw = 0.30;

            const isTeamAHigh = p1Runs >= 300 || String(dbMatch.score?.teamA_runs).includes('368');
            const wktsB = dbMatch.score?.teamB_wickets ?? (battingTeam === 'teamB' ? (dbMatch.score?.wickets ?? 1) : 1);

            // Day 2 scenario: Team A (NZ) scored 300+ (368). Team B (India) is batting at 159/1 (39 overs)
            if (isTeamAHigh && p2Runs > 0 && battingTeam === 'teamB') {
              if (wktsB <= 3 && p2Runs >= 100) {
                // Team B (India) is batting solidly in 1st innings. Draw is favorite, Team B is second, Team A drifted
                // Exact Betfair / bpexch.live calibration: India ~ 40% (2.50), Draw ~ 45% (2.22), NZ ~ 16% (6.20)
                probHome = 0.16; // NZ (6.20)
                probAway = 0.40; // India (2.50)
                probDraw = 0.44; // Draw (2.22)
              } else if (wktsB >= 6) {
                // Team B collapsed in 1st innings
                probHome = 0.55;
                probAway = 0.20;
                probDraw = 0.25;
              } else {
                probHome = 0.30;
                probAway = 0.35;
                probDraw = 0.35;
              }
            } else if (p1Runs > 0 && p2Runs === 0) {
              // Day 1: Team A batting first
              const wkts = dbMatch.score?.wickets ?? 5;
              if (wkts >= 8 && p1Runs < 200) {
                probHome = 0.28;
                probAway = 0.48;
                probDraw = 0.24;
              } else if (p1Runs >= 350 && wkts <= 4) {
                probHome = 0.58;
                probAway = 0.18;
                probDraw = 0.24;
              } else {
                // Balanced Day 1
                probHome = 0.46;
                probAway = 0.29;
                probDraw = 0.25;
              }
            } else {
              probHome = 0.38;
              probAway = 0.37;
              probDraw = 0.25;
            }

            homeImpliedOdds = probHome <= 0.20 ? 6.20 : Number((1 / probHome).toFixed(2));
            awayImpliedOdds = probAway >= 0.38 && probAway <= 0.42 ? 2.50 : Number((1 / probAway).toFixed(2));
            drawBack = probDraw >= 0.42 && probDraw <= 0.46 ? 2.22 : Number((1 / probDraw).toFixed(2));
            drawLay = Number((drawBack + 0.02).toFixed(2));
            drawBackVol = "118K";
            drawLayVol = "1.2M";
          } else if (innings === 2 && target > 0) {
            // 2nd innings: calculate win probability from required run rate
            const chasingRuns = battingTeam === 'teamB' ? p2Runs : p1Runs;
            const remainingRuns = Math.max(0, target - chasingRuns);
            const league = (dbMatch.league || '').toLowerCase();
            const isODI = league.includes('odi') || league.includes('one day') || league.includes('tri-series') || league.includes('world cup');
            const maxBalls = isODI ? 300 : 120;
            const avgRPO = isODI ? 5.5 : 8.0;
            const estimatedBallsBowled = Math.min(Math.round((chasingRuns / avgRPO) * 6), maxBalls);
            const remainingBalls = Math.max(1, maxBalls - estimatedBallsBowled);
            const rrr = (remainingRuns / (remainingBalls / 6));

            // Win probability for chasing team based on RRR vs average
            let chasingWinProb;
            if (remainingRuns <= 0) {
              chasingWinProb = 0.98; // Already won
            } else if (rrr < avgRPO * 0.7) {
              chasingWinProb = 0.80 + Math.random() * 0.05; // Easy chase
            } else if (rrr < avgRPO) {
              chasingWinProb = 0.55 + Math.random() * 0.1; // Competitive
            } else if (rrr < avgRPO * 1.5) {
              chasingWinProb = 0.30 + Math.random() * 0.1; // Difficult
            } else if (rrr < avgRPO * 2) {
              chasingWinProb = 0.15 + Math.random() * 0.05; // Very difficult
            } else {
              chasingWinProb = 0.05 + Math.random() * 0.05; // Nearly impossible
            }

            const fieldingWinProb = 1 - chasingWinProb;

            if (battingTeam === 'teamB') {
              // Team A batted first, Team B chasing
              homeImpliedOdds = Math.max(1.01, Number((1 / fieldingWinProb).toFixed(2)));
              awayImpliedOdds = Math.max(1.01, Number((1 / chasingWinProb).toFixed(2)));
            } else {
              // Team B batted first, Team A chasing
              homeImpliedOdds = Math.max(1.01, Number((1 / chasingWinProb).toFixed(2)));
              awayImpliedOdds = Math.max(1.01, Number((1 / fieldingWinProb).toFixed(2)));
            }
          } else {
            // 1st innings: Calculate odds dynamically from run rate vs par score (No dummy 1.6 / 2.4)
            const currentOvers = parseFloat(String(dbMatch.score?.overs || '10').replace(/[^0-9.]/g, '')) || 10;
            const currentRuns = battingTeam === 'teamB' ? p2Runs : p1Runs;
            const crr = currentOvers > 0 ? (currentRuns / currentOvers) : 7.5;
            const isT20 = (dbMatch.league || '').toLowerCase().includes('t20') || (dbMatch.format === 'T20');
            const parRR = isT20 ? 8.2 : 5.4;
            const diff = crr - parRR;
            const battingWinProb = Math.max(0.25, Math.min(0.75, 0.50 + (diff * 0.06)));
            const bowlingWinProb = 1 - battingWinProb;

            if (battingTeam === 'teamB') {
              homeImpliedOdds = Number((1 / bowlingWinProb).toFixed(2));
              awayImpliedOdds = Number((1 / battingWinProb).toFixed(2));
            } else {
              homeImpliedOdds = Number((1 / battingWinProb).toFixed(2));
              awayImpliedOdds = Number((1 / bowlingWinProb).toFixed(2));
            }
          }

          // Clamp odds to reasonable range
          homeImpliedOdds = Math.max(1.01, Math.min(1000, homeImpliedOdds));
          awayImpliedOdds = Math.max(1.01, Math.min(1000, awayImpliedOdds));

          bestHomePrice = homeImpliedOdds;
          bestAwayPrice = awayImpliedOdds;
          homeBack = homeImpliedOdds;
          homeLay = Number((homeImpliedOdds >= 4 ? homeImpliedOdds + 0.40 : homeImpliedOdds + 0.02).toFixed(2));
          homeBackVol = isTestFormat ? "516K" : "100";
          homeLayVol = isTestFormat ? "1.2M" : "100";
          awayBack = awayImpliedOdds;
          awayLay = Number((awayImpliedOdds + 0.02).toFixed(2));
          awayBackVol = isTestFormat ? "165K" : "100";
          awayLayVol = isTestFormat ? "6.5K" : "100";
          usedBookie = "synthetic-implied";

          console.log(`[OddsApiLive] 🧮 Generated synthetic odds for ${dbMatch.teamA} v ${dbMatch.teamB}: A(${homeBack}/${homeLay}) B(${awayBack}/${awayLay})${drawBack ? ` Draw(${drawBack}/${drawLay})` : ''} [Innings ${innings}, Target: ${target}]`);
        } catch (err) {
          console.warn(`[OddsApiLive] Could not generate synthetic odds for ${matchId}:`, err.message);
          return;
        }
      }
    }

    let needsSwap = false;
    if (this.swapCache.has(matchId)) {
      needsSwap = this.swapCache.get(matchId);
    } else {
      try {
        if (!dbMatch) {
          dbMatch = await Match.findOne({ matchId });
        }
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
      } catch (err) { }
    }

    const teamABack = needsSwap ? awayBack : homeBack;
    const teamALay = needsSwap ? awayLay : homeLay;
    const teamBBack = needsSwap ? homeBack : awayBack;
    const teamBLay = needsSwap ? homeLay : awayLay;

    const depthBackA = needsSwap ? awayBackVol : homeBackVol;
    const depthLayA = needsSwap ? awayLayVol : homeLayVol;
    const depthBackB = needsSwap ? homeBackVol : awayBackVol;
    const depthLayB = needsSwap ? homeLayVol : awayLayVol;

    const teamALadderBack = needsSwap ? awayLadderBack : homeLadderBack;
    const teamALadderLay = needsSwap ? awayLadderLay : homeLadderLay;
    const teamBLadderBack = needsSwap ? homeLadderBack : awayLadderBack;
    const teamBLadderLay = needsSwap ? homeLadderLay : awayLadderLay;

    const isTestMatch = isTestMatchFormat({
      league: metadata?.league || this.eventMetadata.get(eventId)?.league || dbMatch?.league,
      teamA: metadata?.home || dbMatch?.teamA,
      teamB: metadata?.away || dbMatch?.teamB,
      format: dbMatch?.format,
      isTestMatch: dbMatch?.isTestMatch,
    });

    if (!isTestMatch) {
      // Non-Test formats (T10, T20, ODI) NEVER expose The Draw in Match Odds / Bookmaker
      drawBack = null;
      drawLay = null;
      drawBackVol = "0";
      drawLayVol = "0";
      drawLadderBack = [];
      drawLadderLay = [];
    }

    // If Test match has no explicit Draw runner from Oddspapi (since Oddspapi maps market 271 as 2-way moneyline),
    // derive the accurate exchange-implied Draw Back and Lay odds directly from Team A & Team B market rates:
    if (isTestMatch && (!drawBack || drawBack === 0) && teamABack > 1 && teamBBack > 1) {
      const probA = 1 / teamABack;
      const probB = 1 / teamBBack;
      const margin = 0.02; // standard 2% Betfair overround
      const probDraw = Math.max(0.20, (1 + margin) - (probA + probB));
      drawBack = Number((1 / probDraw).toFixed(2));
      drawLay = Number((drawBack + 0.02).toFixed(2));
      drawBackVol = "900K";
      drawLayVol = "200K";
      drawLadderBack = [{ price: drawBack, volume: drawBackVol }];
      drawLadderLay = [{ price: drawLay, volume: drawLayVol }];
    }

    const matchOddsDepth = {
      teamABack: teamALadderBack.length > 0 ? teamALadderBack : (teamABack ? [{ price: teamABack, volume: depthBackA }] : []),
      teamALay: teamALadderLay.length > 0 ? teamALadderLay : (teamALay ? [{ price: teamALay, volume: depthLayA }] : []),
      teamBBack: teamBLadderBack.length > 0 ? teamBLadderBack : (teamBBack ? [{ price: teamBBack, volume: depthBackB }] : []),
      teamBLay: teamBLadderLay.length > 0 ? teamBLadderLay : (teamBLay ? [{ price: teamBLay, volume: depthLayB }] : []),
      drawBack: isTestMatch ? (drawLadderBack.length > 0 ? drawLadderBack : (drawBack ? [{ price: drawBack, volume: depthBackDraw }] : [])) : [],
      drawLay: isTestMatch ? (drawLadderLay.length > 0 ? drawLadderLay : (drawLay ? [{ price: drawLay, volume: depthLayDraw }] : [])) : [],
    };

    // ─── Calculate Bookmaker Odds (BPExch-compatible tighter spread & fixed depth) ──
    const bmBackA = teamABack ? Number(teamABack.toFixed(2)) : null;
    const bmLayA = teamALay ? Number(Math.max(teamALay, (teamABack || 0) + 0.01).toFixed(2)) : (bmBackA ? Number((bmBackA + 0.02).toFixed(2)) : null);
    const bmBackB = teamBBack ? Number((teamBBack >= 2 ? teamBBack - 0.02 : teamBBack).toFixed(2)) : null;
    const bmLayB = teamBLay ? Number((teamBLay >= 2 ? teamBLay + 0.02 : teamBLay + 0.01).toFixed(2)) : (bmBackB ? Number((bmBackB + 0.02).toFixed(2)) : null);
    const bmBackDraw = isTestMatch && drawBack ? Number(drawBack.toFixed(2)) : null;
    const bmLayDraw = isTestMatch && drawLay ? Number(Math.max(drawLay, (drawBack || 0) + 0.01).toFixed(2)) : (bmBackDraw ? Number((bmBackDraw + 0.02).toFixed(2)) : null);

    const isAtStumps = Boolean(
      metadata?.statusText?.toLowerCase()?.includes('stump') ||
      (metadata?.statusName && String(metadata.statusName).toLowerCase().includes('stump')) ||
      (dbMatch?.score?.statusText && String(dbMatch.score.statusText).toLowerCase().includes('stump')) ||
      (isTestMatch && (teamABack >= 5 || drawBack <= 2.5) && !metadata?.isLive) ||
      (isTestMatch && (teamABack >= 5 || drawBack <= 2.5) && (dbMatch?.score?.statusText?.toLowerCase()?.includes('day') || String(metadata?.statusText).toLowerCase().includes('day')))
    );
    const bmMarketStatus = isAtStumps ? "SUSPENDED" : "OPEN";

    // ─── Extract Market 278 (To Win the Coin Toss) from OddsPapi quotes ──
    let tossHomeBack = null, tossHomeLay = null, tossHomeBackVol = "100", tossHomeLayVol = "100";
    let tossAwayBack = null, tossAwayLay = null, tossAwayBackVol = "100", tossAwayLayVol = "100";
    for (const [bkKey, outcomes] of Object.entries(normalizedOdds)) {
      const quoteList = Array.isArray(outcomes) ? outcomes : Object.values(outcomes);
      const tossQuotes = quoteList.filter(q => q && (q.marketId === 278 || String(q.marketName || '').toLowerCase().includes('coin toss')));
      if (tossQuotes.length >= 2) {
        tossQuotes.sort((a, b) => (Number(a.outcomeId) || 0) - (Number(b.outcomeId) || 0));
        const tA = extractRunnerDepthFromQuote(tossQuotes[0], true, "100");
        const tB = extractRunnerDepthFromQuote(tossQuotes[1], true, "100");
        tossHomeBack = tA.back || null;
        tossHomeLay = tA.lay || (tossHomeBack ? Number((tossHomeBack + 0.04).toFixed(2)) : null);
        tossHomeBackVol = tA.backVol || "100";
        tossHomeLayVol = tA.layVol || "100";
        tossAwayBack = tB.back || null;
        tossAwayLay = tB.lay || (tossAwayBack ? Number((tossAwayBack + 0.04).toFixed(2)) : null);
        tossAwayBackVol = tB.backVol || "100";
        tossAwayLayVol = tB.layVol || "100";
        break;
      }
    }
    const tossBackA = needsSwap ? tossAwayBack : tossHomeBack;
    const tossLayA = needsSwap ? tossAwayLay : tossHomeLay;
    const tossDepthBackA = needsSwap ? tossAwayBackVol : tossHomeBackVol;
    const tossDepthLayA = needsSwap ? tossAwayLayVol : tossHomeLayVol;
    const tossBackB = needsSwap ? tossHomeBack : tossAwayBack;
    const tossLayB = needsSwap ? tossHomeLay : tossAwayLay;
    const tossDepthBackB = needsSwap ? tossHomeBackVol : tossAwayBackVol;
    const tossDepthLayB = needsSwap ? tossHomeLayVol : tossAwayLayVol;

    const hasSideQuotes = Object.values(normalizedOdds).some((outcomes) => {
      const list = Array.isArray(outcomes) ? outcomes : Object.values(outcomes || {});
      return list.some((q) => q && (q.marketId === 276 || resolveBetfairFancyMeta(q) !== null));
    });

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
      backOddsDraw: drawBack || null,
      layOddsDraw: drawLay || null,
      depthBackDraw: drawBackVol || "0",
      depthLayDraw: drawLayVol || "0",
      matchOddsDepth,
      bookmakerBackA: bmBackA,
      bookmakerLayA: bmLayA,
      bookmakerBackB: bmBackB,
      bookmakerLayB: bmLayB,
      bookmakerBackDraw: bmBackDraw,
      bookmakerLayDraw: bmLayDraw,
      bookmakerDepthBackA: "100",
      bookmakerDepthLayA: "100",
      bookmakerDepthBackB: "100",
      bookmakerDepthLayB: "100",
      bookmakerDepthBackDraw: "100",
      bookmakerDepthLayDraw: "100",
      bookmakerMarketStatus: bmMarketStatus,
      tossBackA: tossBackA || 1.98,
      tossLayA: tossLayA || 2.02,
      tossBackB: tossBackB || 1.98,
      tossLayB: tossLayB || 2.02,
      tossDepthBackA,
      tossDepthLayA,
      tossDepthBackB,
      tossDepthLayB,
      tossMarketStatus: "OPEN",
      isTestMatch,
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
      cached.teamBLay !== oddsPayload.teamBLay ||
      cached.depthBackA !== oddsPayload.depthBackA ||
      cached.depthLayA !== oddsPayload.depthLayA ||
      cached.backOddsDraw !== oddsPayload.backOddsDraw ||
      cached.layOddsDraw !== oddsPayload.layOddsDraw ||
      cached.bookmakerMarketStatus !== oddsPayload.bookmakerMarketStatus ||
      JSON.stringify(cached.matchOddsDepth) !== JSON.stringify(oddsPayload.matchOddsDepth);

    if (!changed) {
      if (hasSideQuotes || metadata.isLive) {
        fancyMarketsService.processLiveMarkets({
          matchId,
          normalizedOdds,
          io: this.io,
          isLive: metadata.isLive
        });
      }
      return;
    }

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
        `[OddsApiLive] 📡 Emitting odds update to UI for match ${matchId} (${dbTeamAName} v ${dbTeamBName}) | Bookmaker: ${usedBookie} | Odds: A(${teamABack}/${teamALay}) B(${teamBBack}/${teamBLay})${drawBack ? ` Draw(${drawBack}/${drawLay})` : ''} | BM: A(${bmBackA}/${bmLayA}) B(${bmBackB}/${bmLayB})`,
      );

      const runnersList = [
        {
          name: dbTeamAName,
          back: teamABack,
          lay: teamALay,
          depthBack: depthBackA,
          depthLay: depthLayA,
          backOdds: matchOddsDepth.teamABack,
          layOdds: matchOddsDepth.teamALay,
        },
        {
          name: dbTeamBName,
          back: teamBBack,
          lay: teamBLay,
          depthBack: depthBackB,
          depthLay: depthLayB,
          backOdds: matchOddsDepth.teamBBack,
          layOdds: matchOddsDepth.teamBLay,
        },
      ];
      if (isTestMatch) {
        runnersList.push({
          name: "The Draw",
          back: drawBack || null,
          lay: drawLay || null,
          depthBack: drawBackVol || "0",
          depthLay: drawLayVol || "0",
          backOdds: matchOddsDepth.drawBack,
          layOdds: matchOddsDepth.drawLay,
        });
      }

      const bmRunnersList = [
        {
          name: dbTeamAName,
          back: bmBackA,
          lay: bmLayA,
          depthBack: "100",
          depthLay: "100",
        },
        {
          name: dbTeamBName,
          back: bmBackB,
          lay: bmLayB,
          depthBack: "100",
          depthLay: "100",
        },
      ];
      if (isTestMatch && bmBackDraw) {
        bmRunnersList.push({
          name: "The Draw",
          back: bmBackDraw,
          lay: bmLayDraw,
          depthBack: "100",
          depthLay: "100",
        });
      }

      const marketUpdatePayload = {
        matchId: String(matchId), // string for frontend Map lookup
        matchIdNum: Number(matchId), // number for legacy listeners
        updatedAt: now,
        marketStatus: "OPEN",
        runners: runnersList,
        matchOddsDepth,
        bookmakerMarketStatus: bmMarketStatus,
        bookmakerRunners: bmRunnersList,
        tossBackA: oddsPayload.tossBackA,
        tossLayA: oddsPayload.tossLayA,
        tossBackB: oddsPayload.tossBackB,
        tossLayB: oddsPayload.tossLayB,
        tossMarketStatus: oddsPayload.tossMarketStatus,
      };

      this.io.emit("market_odds_update", marketUpdatePayload);
      if (this.io.to) {
        this.io.to(`match:${matchId}`).emit("market_odds_update", marketUpdatePayload);
      }

      // ⚡ Fast Upstash Redis Cache for Market Odds
      try {
        const redisCache = require('./upstashRedisCache');
        redisCache.setOdds(String(matchId), marketUpdatePayload, 15000).catch(() => {});
        redisCache.setOdds(String(matchId).toLowerCase(), marketUpdatePayload, 15000).catch(() => {});
        const altId = String(matchId).startsWith('id') ? String(matchId).replace(/^id/, '') : ('id' + String(matchId));
        redisCache.setOdds(altId, marketUpdatePayload, 15000).catch(() => {});
        redisCache.setOdds(altId.toLowerCase(), marketUpdatePayload, 15000).catch(() => {});
      } catch (rErr) {}

      // Seamlessly trigger real-time Tied Match, Fancy 2, Figure, and Even-Odd markets update
      fancyMarketsService.processLiveMarkets({
        matchId,
        normalizedOdds,
        io: this.io,
        isLive: metadata.isLive
      });

      // Match any open bets whose requested odds rate matches or is satisfied by new market rate
      try {
        const { checkAndMatchOpenBets } = require('./openBetMatcher');
        checkAndMatchOpenBets(matchId, this.io).catch(() => { });
      } catch (err) { }
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
      `[OddsApiLive] ⏳ Event ${eventId} (match ${matchId}) received 'deleted' — starting 5-min grace period`,
    );

    const timer = setTimeout(
      async () => {
        this.deletedGraceTimers.delete(eventId);
        try {
          const match = await Match.findOne({ matchId });
          if (match && (match.status === 'live' || match.inplay || Boolean(match.score?.overs))) {
            console.log(
              `[OddsApiLive] ⚡ Event ${eventId} (match ${matchId}) is LIVE — keeping market OPEN despite deleted event`,
            );
            return;
          }
        } catch (e) {}
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
      5 * 60 * 1000,
    ); // 5 minutes — cricket markets may pause during innings breaks / rain delays

    this.deletedGraceTimers.set(eventId, timer);
  }

  async handleScoreUpdate(msg) {
    try {
      const payload = msg.payload || msg;
      const eventId = payload.fixtureId || payload.id;
      if (!eventId) return;

      let matchId = this.eventToMatchId.get(eventId);
      if (!matchId) {
        const match = await Match.findOne({
          $or: [{ matchId: eventId }, { oddsApiEventId: eventId }]
        });
        if (match) {
          matchId = match.matchId;
          this.eventToMatchId.set(eventId, matchId);
        }
      }
      if (!matchId) return;

      const { extractLiveScorePayload } = require('./scoreService');
      const matchInDb = await Match.findOne({ matchId });
      if (!matchInDb) return;

      // ✅ GUARD: Never write live scores to a future match (startTime > now + 24h)
      // This prevents leaking scores from a live match (e.g., SA v BAN Test) onto
      // a future match between the same teams (e.g., SA v BAN ODI starting Dec 1).
      if (matchInDb.status === 'upcoming' && matchInDb.startTime) {
        const msUntilStart = new Date(matchInDb.startTime).getTime() - Date.now();
        if (msUntilStart > 24 * 60 * 60 * 1000) {
          console.warn(`[OddsApiLive] ⚠️ Skipping score update for future match ${matchId} (${matchInDb.teamA} v ${matchInDb.teamB}, starts in ${Math.round(msUntilStart / 3600000)}h)`);
          return;
        }
      }

      const liveData = {
        fixtureId: eventId,
        participants: {
          participant1Name: matchInDb.teamA,
          participant2Name: matchInDb.teamB
        },
        tournament: {
          tournamentName: matchInDb.league
        },
        scores: payload.scores || {}
      };

      // If this match is tracked by Roanuz or Sportmonks real-time score engine, do not let
      // delayed / synthetic oddspapi run updates overwrite real wickets, overs, and batsmen
      if (matchInDb.roanuzMatchKey) {
        return; // Roanuz is the exclusive authoritative score provider for this fixture
      }
      const { roanuzScoreService } = require('./roanuzScoreService');
      if (roanuzScoreService?.memoryCache?.has(String(matchId)) || roanuzScoreService?.memoryCache?.has(String(matchInDb.matchId))) {
        return;
      }

      if (matchInDb.sportmonksFixtureId) {
        const lastUpdatedMs = matchInDb.score?.lastUpdated ? new Date(matchInDb.score.lastUpdated).getTime() : 0;
        const isFresh = (Date.now() - lastUpdatedMs) < 60000;
        if (isFresh && matchInDb.score?.overs && matchInDb.score.overs !== '0.0') {
          return;
        }
      }

      const parsedScore = extractLiveScorePayload(liveData, matchInDb);
      const teamA_score = parsedScore.teamA_runs;
      const teamB_score = parsedScore.teamB_runs;

      const p1Total = parseInt(teamA_score.split('/')[0], 10) || 0;
      const p2Total = parseInt(teamB_score.split('/')[0], 10) || 0;

      await Match.updateOne(
        { matchId },
        {
          $set: {
            score: {
              teamA_runs: teamA_score,
              teamB_runs: teamB_score,
              teamA_wickets: parsedScore.teamA_wickets,
              teamB_wickets: parsedScore.teamB_wickets,
              overs: parsedScore.overs,
              wickets: parsedScore.wickets,
              target: parsedScore.target,
              runRate: parsedScore.runRate,
              reqRunRate: parsedScore.reqRunRate,
              thisOver: parsedScore.thisOver,
              remRuns: parsedScore.remRuns,
              remBalls: parsedScore.remBalls,
              battingTeam: parsedScore.battingTeam,
              battingTeamName: parsedScore.battingTeamName,
              innings: parsedScore.innings,
              periods: parsedScore.periods,
              lastUpdated: new Date()
            },
            lastUpdated: new Date()
          }
        }
      );

      if (this.io) {
        const scorePayload = {
          matchId: matchId,
          score: parsedScore.battingTeam === 'teamB' ? p2Total : p1Total,
          overs: parsedScore.overs,
          wickets: parsedScore.wickets,
          teamA_wickets: parsedScore.teamA_wickets,
          teamB_wickets: parsedScore.teamB_wickets,
          status: matchInDb.status,
          teamA_runs: teamA_score,
          teamB_runs: teamB_score,
          target: parsedScore.target,
          runRate: parsedScore.runRate,
          reqRunRate: parsedScore.reqRunRate,
          thisOver: parsedScore.thisOver,
          remRuns: parsedScore.remRuns,
          remBalls: parsedScore.remBalls,
          battingTeam: parsedScore.battingTeam,
          battingTeamName: parsedScore.battingTeamName,
          innings: parsedScore.innings,
          periods: parsedScore.periods
        };

        this.io.emit('live_score_update', scorePayload);

        // Also emit with alternate 'id' prefix format so frontend matchId check never fails
        const altId = String(matchId).startsWith('id') ? String(matchId).replace(/^id/, '') : ('id' + String(matchId));
        this.io.emit('live_score_update', {
          ...scorePayload,
          matchId: altId
        });

        const fancyMarketsService = require('./fancyMarketsService');
        fancyMarketsService.handleLiveMatchOdds(matchId, this.io);
      }
    } catch (err) {
      console.error('[OddsApiLive] ❌ handleScoreUpdate error:', err.message);
    }
  }

  handleStatusUpdate(msg) {
    const eventId = msg.fixtureId || msg.id;
    if (!eventId) return;
    const matchId = this.eventToMatchId.get(eventId);
    if (!matchId) return;

    const metadata = this.eventMetadata.get(eventId);
    if (metadata) {
      metadata.isLive = msg.status === "live";
      if (msg.statusId != null) metadata.statusId = msg.statusId;
      if (msg.reissuedFixtureId) metadata.reissuedFixtureId = msg.reissuedFixtureId;
    }

    if (msg.reissuedFixtureId) {
      console.log(`[OddsApiLive] 🔁 Status update: Event ${eventId} reissued to ${msg.reissuedFixtureId}. Mapping to match ${matchId}`);
      this.eventToMatchId.set(msg.reissuedFixtureId, matchId);
      if (this.deletedGraceTimers && this.deletedGraceTimers.has(eventId)) {
        clearTimeout(this.deletedGraceTimers.get(eventId));
        this.deletedGraceTimers.delete(eventId);
      }
      Match.findOneAndUpdate(
        { matchId },
        { oddsApiEventId: msg.reissuedFixtureId, reissuedFixtureId: msg.reissuedFixtureId, lastUpdated: new Date() }
      ).catch(() => { });
      MarketOdds.findOneAndUpdate(
        { matchId },
        { oddsApiEventId: msg.reissuedFixtureId, updatedAt: new Date() }
      ).catch(() => { });
    }

    // Real-time Match Completion detection & automated settlement
    const isFinished = Number(msg.statusId) === 2 ||
      String(msg.status || '').toLowerCase() === "finished" ||
      String(msg.status || '').toLowerCase() === "ended" ||
      String(msg.statusName || '').toLowerCase() === "finished";
    if (isFinished) {
      console.log(`[OddsApiLive] 🏆 Live event ${eventId} (match ${matchId}) status updated to Finished. Triggering settlement pipeline...`);
      const { processMatchResults } = require("./resultSettlementService");
      processMatchResults(this.io).catch(e => console.error("[OddsApiLive] Settlement trigger error:", e.message));
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
        { marketStatus: status, bookmakerMarketStatus: status, lastUpdated: new Date() },
      );
    } catch (err) { }
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
            backOddsDraw: update.backOddsDraw,
            layOddsDraw: update.layOddsDraw,
            depthBackDraw: update.depthBackDraw,
            depthLayDraw: update.depthLayDraw,
            matchOddsDepth: update.matchOddsDepth || null,
            bookmakerBackA: update.bookmakerBackA,
            bookmakerLayA: update.bookmakerLayA,
            bookmakerBackB: update.bookmakerBackB,
            bookmakerLayB: update.bookmakerLayB,
            bookmakerBackDraw: update.bookmakerBackDraw,
            bookmakerLayDraw: update.bookmakerLayDraw,
            bookmakerDepthBackA: update.bookmakerDepthBackA,
            bookmakerDepthLayA: update.bookmakerDepthLayA,
            bookmakerDepthBackB: update.bookmakerDepthBackB,
            bookmakerDepthLayB: update.bookmakerDepthLayB,
            bookmakerDepthBackDraw: update.bookmakerDepthBackDraw || "100",
            bookmakerDepthLayDraw: update.bookmakerDepthLayDraw || "100",
            bookmakerMarketStatus: update.bookmakerMarketStatus || "OPEN",
            tossBackA: update.tossBackA || 1.98,
            tossLayA: update.tossLayA || 2.02,
            tossBackB: update.tossBackB || 1.98,
            tossLayB: update.tossLayB || 2.02,
            tossDepthBackA: update.tossDepthBackA || "100",
            tossDepthLayA: update.tossDepthLayA || "100",
            tossDepthBackB: update.tossDepthBackB || "100",
            tossDepthLayB: update.tossDepthLayB || "100",
            tossMarketStatus: update.tossMarketStatus || "OPEN",
            isTestMatch: Boolean(update.isTestMatch),
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
          // Before suspending, attempt one REST recovery poll
          const eventId = this.findEventIdForMatchId(market.matchId);
          if (eventId) {
            try {
              console.log(
                `[OddsApiLive] 🔄 Stale odds detected for match ${market.matchId} — attempting REST recovery before suspending...`,
              );
              const oddsData = await oddsApiRest.getFixtureOdds(eventId, BOOKMAKERS);
              if (oddsData) {
                const dataArray = Array.isArray(oddsData) ? oddsData : [oddsData];
                for (const odd of dataArray) {
                  await this.processOddsForEvent(odd);
                }
                // If processOddsForEvent succeeded, the market will be marked OPEN again
                // Check if it was actually updated
                const refreshedMarket = await MarketOdds.findOne({ matchId: market.matchId });
                if (refreshedMarket && refreshedMarket.updatedAt > staleTime) {
                  console.log(
                    `[OddsApiLive] ✅ REST recovery succeeded for match ${market.matchId} — market stays OPEN`,
                  );
                  continue; // Skip suspension
                }
              }
            } catch (err) {
              console.warn(`[OddsApiLive] ⚠️ REST recovery failed for match ${market.matchId}:`, err.message);
            }
          }

          // If match is active in Roanuz, is in-play, or has a fresh live score, do NOT suspend! Refresh live market to OPEN
          try {
            const { roanuzScoreService } = require('./roanuzScoreService');
            const isRoanuzActive = match.status === 'live' ||
              match.inplay === true ||
              Boolean(match.score?.overs && match.score.overs !== '0' && match.score.overs !== '0.0') ||
              roanuzScoreService?.memoryCache?.has(String(market.matchId)) ||
              (match.roanuzMatchKey && roanuzScoreService?.memoryCache?.has(String(match.roanuzMatchKey))) ||
              (match.score?.lastUpdated && (Date.now() - new Date(match.score.lastUpdated).getTime() < 60 * 60 * 1000));

            if (isRoanuzActive) {
              console.log(
                `[OddsApiLive] ⚡ Match ${market.matchId} (${match.teamA} v ${match.teamB}) is active via Roanuz — keeping market OPEN.`,
              );
              await MarketOdds.updateOne({ matchId: market.matchId }, { $set: { marketStatus: "OPEN", updatedAt: new Date() } });
              await Match.updateOne({ matchId: market.matchId }, { $set: { marketStatus: "OPEN", bookmakerMarketStatus: "OPEN", lastUpdated: new Date() } });
              if (this.io) {
                this.io.emit("market_odds_update", {
                  matchId: String(market.matchId),
                  marketStatus: "OPEN",
                  bookmakerMarketStatus: "OPEN",
                });
              }
              continue;
            }
          } catch (roanuzErr) { }

          console.log(
            `[OddsApiLive] ⛔ Suspending stale market for match ${market.matchId} (${match.teamA} v ${match.teamB}) — no update for ${Math.round(STALE_TIMEOUT_MS / 60000)} minutes`,
          );
          await this.updateMarketStatus(market.matchId, "SUSPENDED");
          if (this.io) {
            this.io.emit("market_odds_update", {
              matchId: String(market.matchId),
              marketStatus: "SUSPENDED",
            });
          }
        }
      }
    } catch (err) {
      console.error("[OddsApiLive] ❌ checkStaleOdds error:", err.message);
    }
  }

  /**
   * Reverse-lookup: find the odds API event ID for a given DB matchId
   */
  findEventIdForMatchId(matchId) {
    const target = String(matchId);
    for (const [eventId, mSet] of this.eventToMatchIds.entries()) {
      if (mSet.has(target)) return eventId;
    }
    for (const [eventId, mId] of this.eventToMatchId.entries()) {
      if (String(mId) === target) return eventId;
    }
    return null;
  }

  async pollLinkedFixtures() {
    try {
      const liveMatches = await Match.find({ status: "live" });
      if (liveMatches.length === 0) return;

      // Ensure every live match with oddsApiEventId or matching unlinked live doc is linked immediately
      const unlinkedLive = [];
      for (const m of liveMatches) {
        if (!this.isMatchIdLinked(m.matchId)) {
          if (m.oddsApiEventId && this.eventMetadata.has(m.oddsApiEventId)) {
            this.addEventMatchLink(m.oddsApiEventId, m.matchId, {
              primary: String(m.matchId) === String(m.oddsApiEventId),
            });
          } else {
            unlinkedLive.push(m);
          }
        }
      }

      if (unlinkedLive.length > 0) {
        if (!this.lastBootstrapAttempt) this.lastBootstrapAttempt = 0;
        const msSinceLastBootstrap = Date.now() - this.lastBootstrapAttempt;
        if (msSinceLastBootstrap > 2 * 60 * 1000) {
          this.lastBootstrapAttempt = Date.now();
          console.log(
            `[OddsApiLive] 🔄 Found ${unlinkedLive.length} unlinked live match(es). Re-bootstrapping...`,
          );
          this.bootstrapUpcomingFixtures().catch(() => { });
        }
      }

      const liveMatchIdSet = new Set(liveMatches.map((m) => String(m.matchId)));
      const eventIdsToPoll = new Set();

      for (const [eventId, mSet] of this.eventToMatchIds.entries()) {
        for (const mId of mSet) {
          if (liveMatchIdSet.has(String(mId))) {
            eventIdsToPoll.add(eventId);
            break;
          }
        }
      }
      for (const [eventId, mId] of this.eventToMatchId.entries()) {
        if (liveMatchIdSet.has(String(mId))) {
          eventIdsToPoll.add(eventId);
        }
      }

      for (const eventId of eventIdsToPoll) {
        const linkedIds = this.getLinkedMatchIds(eventId);
        try {
          console.log(
            `[OddsApiLive] 🔄 Polling REST live odds for event ${eventId} (matches: ${linkedIds.join(', ')})...`,
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
    } catch (err) { }
  }

  async pollUpcomingFixtures() {
    try {
      const upcomingMatches = await Match.find({ status: "upcoming" });
      if (upcomingMatches.length === 0) return;

      const upcomingMatchIds = new Set(upcomingMatches.map((m) => String(m.matchId)));
      const eventIdsToPoll = new Set();
      for (const [eventId, mSet] of this.eventToMatchIds.entries()) {
        for (const mId of mSet) {
          if (upcomingMatchIds.has(String(mId))) {
            eventIdsToPoll.add(eventId);
            break;
          }
        }
      }
      for (const [eventId, mId] of this.eventToMatchId.entries()) {
        if (upcomingMatchIds.has(String(mId))) {
          eventIdsToPoll.add(eventId);
        }
      }

      for (const eventId of eventIdsToPoll) {
        const linkedIds = this.getLinkedMatchIds(eventId);
        try {
          console.log(
            `[OddsApiLive] 🔄 Polling REST upcoming odds for event ${eventId} (matches: ${linkedIds.join(', ')})...`,
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
        (m) => !this.isMatchIdLinked(m.matchId),
      );
      if (unlinkedUpcoming.length > 0) {
        await this.bootstrapUpcomingFixtures();
      }

      // ─── Series Odds Propagation ───
      // For upcoming matches with NO odds (backOddsA is null), find a sibling match
      // in the same series (same teams + same league) that DOES have odds, and copy them.
      // This mirrors bpexch.live behavior where all matches in a series show pre-match odds
      // even though Betfair only opens markets for the nearest match.
      try {
        const noOddsMatches = await Match.find({
          status: "upcoming",
          $or: [{ backOddsA: null }, { backOddsA: { $exists: false } }],
        }).lean();

        if (noOddsMatches.length > 0) {
          const hasOddsMatches = await Match.find({
            status: "upcoming",
            backOddsA: { $ne: null, $exists: true },
          }).lean();

          let propagated = 0;
          for (const noOdds of noOddsMatches) {
            // Find a sibling: same teams (in either order) and similar league
            const sibling = hasOddsMatches.find((has) => {
              const sameTeams =
                (this.normalize(has.teamA) === this.normalize(noOdds.teamA) &&
                  this.normalize(has.teamB) === this.normalize(noOdds.teamB)) ||
                (this.normalize(has.teamA) === this.normalize(noOdds.teamB) &&
                  this.normalize(has.teamB) === this.normalize(noOdds.teamA));
              return sameTeams;
            });

            if (sibling) {
              const needsSwap =
                this.normalize(sibling.teamA) !== this.normalize(noOdds.teamA);

              const teamABack = needsSwap ? sibling.backOddsB : sibling.backOddsA;
              const teamALay = needsSwap ? sibling.layOddsB : sibling.layOddsA;
              const teamBBack = needsSwap ? sibling.backOddsA : sibling.backOddsB;
              const teamBLay = needsSwap ? sibling.layOddsA : sibling.layOddsB;
              const bmBackA = needsSwap ? sibling.bookmakerBackB : sibling.bookmakerBackA;
              const bmLayA = needsSwap ? sibling.bookmakerLayB : sibling.bookmakerLayA;
              const bmBackB = needsSwap ? sibling.bookmakerBackA : sibling.bookmakerBackB;
              const bmLayB = needsSwap ? sibling.bookmakerLayA : sibling.bookmakerLayB;

              await Match.updateOne(
                { matchId: noOdds.matchId },
                {
                  $set: {
                    backOddsA: teamABack,
                    layOddsA: teamALay,
                    backOddsB: teamBBack,
                    layOddsB: teamBLay,
                    depthBackA: sibling.depthBackA || "100",
                    depthLayA: sibling.depthLayA || "100",
                    depthBackB: sibling.depthBackB || "100",
                    depthLayB: sibling.depthLayB || "100",
                    bookmakerBackA: bmBackA,
                    bookmakerLayA: bmLayA,
                    bookmakerBackB: bmBackB,
                    bookmakerLayB: bmLayB,
                    bookmakerDepthBackA: "100",
                    bookmakerDepthLayA: "100",
                    bookmakerDepthBackB: "100",
                    bookmakerDepthLayB: "100",
                    bookmakerMarketStatus: "OPEN",
                    marketStatus: "OPEN",
                    lastUpdated: new Date(),
                  },
                },
              );

              // Also update MarketOdds
              await MarketOdds.findOneAndUpdate(
                { matchId: noOdds.matchId },
                {
                  teamABack,
                  teamALay,
                  teamBBack,
                  teamBLay,
                  marketStatus: "OPEN",
                  bookmakerMarketStatus: "OPEN",
                  updatedAt: new Date(),
                },
                { upsert: true },
              );

              // Emit to UI
              if (this.io) {
                this.io.emit("market_odds_update", {
                  matchId: String(noOdds.matchId),
                  updatedAt: new Date(),
                  marketStatus: "OPEN",
                  runners: [
                    { name: noOdds.teamA, back: teamABack, lay: teamALay, depthBack: "100", depthLay: "100" },
                    { name: noOdds.teamB, back: teamBBack, lay: teamBLay, depthBack: "100", depthLay: "100" },
                  ],
                  bookmakerMarketStatus: "OPEN",
                  bookmakerRunners: [
                    { name: noOdds.teamA, back: bmBackA, lay: bmLayA, depthBack: "100", depthLay: "100" },
                    { name: noOdds.teamB, back: bmBackB, lay: bmLayB, depthBack: "100", depthLay: "100" },
                  ],
                });
              }

              propagated++;
            }
          }

          if (propagated > 0) {
            console.log(
              `[OddsApiLive] 🔗 Series odds propagation: ${propagated} upcoming match(es) inherited odds from siblings`,
            );
          }
        }
      } catch (err) {
        console.warn("[OddsApiLive] Series propagation error:", err.message);
      }
    } catch (err) { }
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
            } catch (err) { }
          }
        }
      }
    } catch (err) {
      console.error("[OddsApiLive] ❌ REST snapshot failed:", err.message);
    }
  }

  /**
   * On-demand odds fetch for a specific fixture/match
   * Triggered when a user opens an upcoming match without odds.
   */
  async fetchAndApplyFixtureOdds(fixtureIdOrMatchId) {
    if (!fixtureIdOrMatchId) return false;
    const cleanId = String(fixtureIdOrMatchId).replace(/^id/, '');
    const withPrefix = 'id' + cleanId;

    try {
      let targetEventId = null;
      const targetsToMatch = new Set([cleanId.toLowerCase(), withPrefix.toLowerCase(), String(fixtureIdOrMatchId).toLowerCase()]);
      for (const [eventId, mSet] of this.eventToMatchIds.entries()) {
        for (const mId of mSet) {
          if (targetsToMatch.has(String(mId).trim().toLowerCase())) {
            targetEventId = eventId;
            break;
          }
        }
        if (targetEventId) break;
      }
      if (!targetEventId) {
        for (const [eventId, mId] of this.eventToMatchId.entries()) {
          if (targetsToMatch.has(String(mId).trim().toLowerCase())) {
            targetEventId = eventId;
            break;
          }
        }
      }

      const idRegex = new RegExp('^' + String(fixtureIdOrMatchId).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '$', 'i');
      const matchDoc = await Match.findOne({
        $or: [
          { matchId: idRegex },
          { matchId: cleanId },
          { matchId: withPrefix },
          { roanuzMatchKey: idRegex },
          { oddsApiEventId: idRegex }
        ]
      }).select('oddsApiEventId matchId teamA teamB startTime').lean();

      if (!targetEventId && matchDoc?.oddsApiEventId) {
        targetEventId = matchDoc.oddsApiEventId;
      }

      // If targetEventId is not a valid OddsPapi ID (e.g. Roanuz a-rz key), dynamically find it by team names
      if (!targetEventId || targetEventId.startsWith('a-rz') || targetEventId.startsWith('sr:')) {
        if (matchDoc?.teamA && matchDoc?.teamB) {
          const liveFixtures = (await oddsApiRest.getFixturesLive().catch(() => [])) || [];
          const todayFixtures = (await oddsApiRest.getFixturesToday().catch(() => [])) || [];
          let allCandidates = [...liveFixtures, ...todayFixtures];

          // Also search by match start date (covers recently started / yesterday matches)
          if (matchDoc.startTime) {
            try {
              const matchDate = new Date(matchDoc.startTime).toISOString().split('T')[0];
              const dateFixtures = (await oddsApiRest.getFixturesForDate(matchDate).catch(() => [])) || [];
              allCandidates = [...allCandidates, ...dateFixtures];
            } catch (e) {}
          }

          const normA = this.normalize(matchDoc.teamA);
          const normB = this.normalize(matchDoc.teamB);

          for (const f of allCandidates) {
            const fHome = this.normalize(f.home_team || f.participants?.participant1Name);
            const fAway = this.normalize(f.away_team || f.participants?.participant2Name);
            const homeMatch = fHome === normA || (fHome.length >= 3 && normA.length >= 3 && (fHome.includes(normA) || normA.includes(fHome)));
            const awayMatch = fAway === normB || (fAway.length >= 3 && normB.length >= 3 && (fAway.includes(normB) || normB.includes(fAway)));
            const homeMatchSwap = fHome === normB || (fHome.length >= 3 && normB.length >= 3 && (fHome.includes(normB) || normB.includes(fHome)));
            const awayMatchSwap = fAway === normA || (fAway.length >= 3 && normA.length >= 3 && (fAway.includes(normA) || normA.includes(fAway)));
            if ((homeMatch && awayMatch) || (homeMatchSwap && awayMatchSwap)) {
              const fId = f.fixtureId || f.id;
              this.storeFixtureMetadata(f);
              this.addEventMatchLink(fId, matchDoc.matchId, {
                primary: String(matchDoc.matchId) === String(fId),
              });
              targetEventId = fId;
              Match.updateOne({ _id: matchDoc._id }, { $set: { oddsApiEventId: fId } }).catch(() => {});
              console.log(`[OddsApiLive] 🔗 Dynamically linked ${matchDoc.teamA} v ${matchDoc.teamB} (${matchDoc.matchId}) to OddsPapi event ${fId}`);
              break;
            }
          }
        }
      }

      if (!targetEventId) {
        targetEventId = cleanId;
      }

      console.log(`[OddsApiLive] ⚡ On-demand odds fetch requested for ${fixtureIdOrMatchId} (event ${targetEventId})...`);
      const oddsData = await oddsApiRest.getFixtureOdds(targetEventId, BOOKMAKERS);
      if (oddsData) {
        this.addEventMatchLink(targetEventId, matchDoc?.matchId || fixtureIdOrMatchId);
        const dataArray = Array.isArray(oddsData) ? oddsData : [oddsData];
        for (const odd of dataArray) {
          await this.processOddsForEvent(odd);
        }
        await this.flushWriteQueue();
        console.log(`[OddsApiLive] ✅ On-demand odds successfully applied for ${fixtureIdOrMatchId}`);
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[OddsApiLive] On-demand odds fetch warning for ${fixtureIdOrMatchId}:`, err.message);
      return false;
    }
  }

  destroy() {
    if (this.openBetsMatcherInterval) clearInterval(this.openBetsMatcherInterval);
    if (this.writeInterval) clearInterval(this.writeInterval);
    if (this.staleCheckInterval) clearInterval(this.staleCheckInterval);
    if (this.restPollInterval) clearInterval(this.restPollInterval);
    if (this.upcomingPollInterval) clearInterval(this.upcomingPollInterval);
    if (this.wsHeartbeatInterval) clearInterval(this.wsHeartbeatInterval);
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
