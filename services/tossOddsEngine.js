/**
 * Toss Odds Engine
 * 
 * Generates synthetic toss odds for cricket matches.
 * 
 * Real-Time Cricket Logic:
 * - In real-time cricket, the toss happens 25–30 minutes BEFORE the match start time.
 * - Once a match reaches its start time, goes live, or has started/completed, the toss has ALREADY been completed.
 * - Therefore, the Toss market MUST be CLOSED for all live, started, and completed matches.
 * - Active toss odds (Back/Lay) are strictly PRE-MATCH (upcoming fixtures before start time).
 * - Once closed, toss odds are nullified and the market is marked 'CLOSED'.
 * - Any pending/MATCHED toss bets remain until settled by admin or match conclusion.
 * 
 * MaxBet: 2M (enforced on frontend & backend)
 */

const Match = require('../models/Match');
const Bet = require('../models/Bet');
const User = require('../models/User');
const { distributeProfitLoss } = require('./hierarchyService');

let ioInstance = null;
let pollInterval = null;

// ─── Toss Odds Generation ──────────────────────────────────────────────────────

/**
 * Universal toss odds for any match:
 * Strictly 1.98 for Back, 2.02 for Lay
 */
function generateTossOdds() {
  return {
    backA: 1.98,
    layA: 2.02,
    backB: 1.98,
    layB: 2.02,
  };
}

/**
 * Generate realistic depth volume strings
 */
function generateDepth() {
  const gen = () => (Math.floor(Math.random() * 400) + 50).toString();
  return {
    depthBackA: gen(),
    depthLayA: gen(),
    depthBackB: gen(),
    depthLayB: gen(),
  };
}

/**
 * Helper to check whether a match has started or is live/completed.
 */
function isMatchStartedOrLive(match, now = new Date()) {
  if (!match) return false;
  if (['live', 'completed', 'resulted', 'closed'].includes(match.status)) return true;
  if (match.startTime && now >= new Date(match.startTime)) return true;
  return false;
}

// ─── Core Polling Loop ─────────────────────────────────────────────────────────

async function updateTossOdds() {
  try {
    const now = new Date();

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Sweep and CLOSE Toss Market for any match that is LIVE, STARTED,
    // or COMPLETED where the toss market is still marked OPEN or has active odds.
    // In real cricket, the toss is 100% completed by match start time!
    // ─────────────────────────────────────────────────────────────────────────
    const startedOrLiveMatches = await Match.find({
      $and: [
        {
          $or: [
            { status: { $in: ['live', 'completed', 'resulted'] } },
            { startTime: { $lte: now } }
          ]
        },
        {
          $or: [
            { tossMarketStatus: { $ne: 'CLOSED' } },
            { tossBackA: { $ne: null } },
            { tossLayA: { $ne: null } }
          ]
        }
      ]
    });

    for (const match of startedOrLiveMatches) {
      await Match.updateOne(
        { matchId: match.matchId },
        {
          $set: {
            tossMarketStatus: 'CLOSED',
            tossBackA: null,
            tossLayA: null,
            tossBackB: null,
            tossLayB: null,
            tossDepthBackA: '0',
            tossDepthLayA: '0',
            tossDepthBackB: '0',
            tossDepthLayB: '0',
            lastUpdated: now
          }
        }
      );

      console.log(`[TossEngine] 🔒 Toss market CLOSED for started/live match: ${match.teamA} v ${match.teamB} (Status: ${match.status})`);

      if (ioInstance) {
        ioInstance.emit('toss_odds_update', {
          matchId: String(match.matchId),
          tossMarketStatus: 'CLOSED',
          tossWinner: match.tossWinner || null,
          tossBackA: null,
          tossLayA: null,
          tossBackB: null,
          tossLayB: null,
          tossDepthBackA: '0',
          tossDepthLayA: '0',
          tossDepthBackB: '0',
          tossDepthLayB: '0',
          isLive: match.status === 'live',
          updatedAt: now
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Only generate active Toss Odds for strictly UPCOMING matches
    // whose start time is in the FUTURE and toss hasn't been decided yet.
    // ─────────────────────────────────────────────────────────────────────────
    const upcomingMatches = await Match.find({
      status: 'upcoming',
      startTime: { $gt: now },
      tossWinner: null
    });

    if (upcomingMatches.length === 0) return;

    for (const match of upcomingMatches) {
      // Re-verify that match hasn't started yet
      if (isMatchStartedOrLive(match, now)) continue;

      const odds = generateTossOdds();
      const depth = generateDepth();

      // Check if odds actually changed (avoid unnecessary DB writes)
      const changed = match.tossBackA !== odds.backA ||
                      match.tossLayA !== odds.layA ||
                      match.tossBackB !== odds.backB ||
                      match.tossLayB !== odds.layB;

      if (!changed && match.tossMarketStatus === 'OPEN') continue;

      // Update upcoming match toss odds in DB
      await Match.updateOne(
        { matchId: match.matchId },
        {
          $set: {
            tossBackA: odds.backA,
            tossLayA: odds.layA,
            tossBackB: odds.backB,
            tossLayB: odds.layB,
            tossDepthBackA: depth.depthBackA,
            tossDepthLayA: depth.depthLayA,
            tossDepthBackB: depth.depthBackB,
            tossDepthLayB: depth.depthLayB,
            tossMarketStatus: 'OPEN',
            lastUpdated: now
          }
        }
      );

      // Emit to UI via socket
      if (ioInstance) {
        ioInstance.emit('toss_odds_update', {
          matchId: String(match.matchId),
          tossBackA: odds.backA,
          tossLayA: odds.layA,
          tossBackB: odds.backB,
          tossLayB: odds.layB,
          tossDepthBackA: depth.depthBackA,
          tossDepthLayA: depth.depthLayA,
          tossDepthBackB: depth.depthBackB,
          tossDepthLayB: depth.depthLayB,
          tossMarketStatus: 'OPEN',
          runners: [
            { name: `${match.teamA} To Win The Toss`, back: odds.backA, lay: odds.layA, depthBack: depth.depthBackA, depthLay: depth.depthLayA },
            { name: `${match.teamB} To Win The Toss`, back: odds.backB, lay: odds.layB, depthBack: depth.depthBackB, depthLay: depth.depthLayB }
          ],
          updatedAt: now
        });
      }
    }
  } catch (err) {
    console.error('[TossEngine] ❌ Error updating toss odds:', err.message);
  }
}

// ─── Toss Settlement ───────────────────────────────────────────────────────────

/**
 * settleToss
 * Settles all pending toss bets for a given match.
 * Called when admin declares the toss winner.
 * 
 * @param {string} matchId - The match ID
 * @param {string} tossWinner - The team that won the toss (runner name as stored in bet) or 'REFUND'
 * @param {object} io - Socket.io instance
 */
async function settleToss(matchId, tossWinner, io) {
  try {
    console.log(`[TossSettlement] Beginning toss settlement for matchId: ${matchId}`);
    console.log(`[TossSettlement] Toss Winner: ${tossWinner}`);

    const altMatchId = String(matchId).startsWith('id') ? String(matchId).replace(/^id/, '') : ('id' + String(matchId));
    const matchIdList = [matchId, altMatchId];

    // Find all active toss bets for this match (both pending and MATCHED)
    const tossBets = await Bet.find({
      matchId: { $in: matchIdList },
      marketType: 'toss',
      status: { $in: ['pending', 'MATCHED'] }
    });

    const isRefund = tossWinner === 'REFUND' || tossWinner === 'VOID';

    for (const bet of tossBets) {
      if (!['pending', 'MATCHED'].includes(bet.status)) continue;

      const isBack = bet.type === 'back';
      const liability = (!isBack && bet.odds > 1) ? Math.round(bet.stake * (bet.odds - 1)) : bet.stake;

      if (isRefund) {
        const user = await User.findOneAndUpdate(
          { username: bet.userId },
          { $inc: { walletBalance: liability } },
          { new: true }
        );

        bet.status = 'cancelled';
        bet.result = tossWinner;
        bet.settledAt = new Date();
        await bet.save();

        console.log(`[TossSettlement] REFUND: User ${bet.userId} refunded ${liability}`);

        if (io && user) {
          io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
          io.emit('bet_settled', {
            betId: bet._id,
            status: 'cancelled',
            message: `Toss Void: ${liability} refunded`,
            matchName: bet.matchName
          });
        }
        continue;
      }

      // Determine if user won:
      // The runner field stores e.g. "England To Win The Toss"
      // The tossWinner is the team name e.g. "England"
      const runnerWon = bet.runner.toLowerCase().includes(tossWinner.toLowerCase());
      const isWin = isBack ? runnerWon : !runnerWon;

      if (isWin) {
        const profit = isBack ? (bet.stake * (bet.odds - 1)) : bet.stake;
        const grossReturn = liability + profit;
        const commission = profit * 0.05;
        const netWin = grossReturn - commission;

        const user = await User.findOneAndUpdate(
          { username: bet.userId },
          { $inc: { walletBalance: netWin } },
          { new: true }
        );

        bet.status = 'won';
        bet.payout = netWin;
        bet.result = tossWinner;
        bet.settledAt = new Date();
        await bet.save();

        const houseLoss = -(profit - commission);
        await distributeProfitLoss(bet.userId, houseLoss, { matchName: bet.matchName, selection: bet.runner });

        console.log(`[TossSettlement] WIN: User ${bet.userId} won ${netWin.toFixed(2)} (Gross: ${grossReturn}, Comm: ${commission.toFixed(2)})`);

        if (io) {
          io.emit('bet_settled', { betId: bet._id, status: 'won', payout: netWin, matchName: bet.matchName });
          if (user) io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
        }
      } else {
        bet.status = 'lost';
        bet.payout = 0;
        bet.result = tossWinner;
        bet.settledAt = new Date();
        await bet.save();

        await distributeProfitLoss(bet.userId, liability, { matchName: bet.matchName, selection: bet.runner });

        console.log(`[TossSettlement] LOSE: User ${bet.userId} lost stake/liability of ${liability}`);

        if (io) {
          io.emit('bet_settled', { betId: bet._id, status: 'lost', payout: 0, matchName: bet.matchName });
        }
      }
    }

    // Close the toss market and nullify live odds
    await Match.updateMany(
      { matchId: { $in: matchIdList } },
      {
        $set: {
          tossMarketStatus: 'CLOSED',
          tossWinner,
          tossBackA: null,
          tossLayA: null,
          tossBackB: null,
          tossLayB: null,
          tossDepthBackA: '0',
          tossDepthLayA: '0',
          tossDepthBackB: '0',
          tossDepthLayB: '0',
          lastUpdated: new Date()
        }
      }
    );

    // Emit toss market closed with winner to UI
    if (io) {
      matchIdList.forEach(id => {
        io.emit('toss_odds_update', {
          matchId: String(id),
          tossMarketStatus: 'CLOSED',
          tossWinner,
          tossBackA: null,
          tossLayA: null,
          tossBackB: null,
          tossLayB: null
        });
      });
    }

    console.log(`[TossSettlement] Finished settling ${tossBets.length} toss bets for matchId: ${matchId}`);
  } catch (err) {
    console.error(`[TossSettlement] CRITICAL ERROR for matchId ${matchId}:`, err.message);
  }
}

// ─── Initialization ────────────────────────────────────────────────────────────

function initTossOddsEngine(io) {
  ioInstance = io;
  console.log('[TossEngine] 🎯 Toss Odds Engine initialized');

  // Normalize all existing upcoming matches to universal toss odds (1.98 & 2.02)
  const now = new Date();
  Match.updateMany(
    {
      status: 'upcoming',
      startTime: { $gt: now },
      tossWinner: null
    },
    {
      $set: {
        tossBackA: 1.98,
        tossLayA: 2.02,
        tossBackB: 1.98,
        tossLayB: 2.02,
        tossDepthBackA: '100',
        tossDepthLayA: '100',
        tossDepthBackB: '100',
        tossDepthLayB: '100',
        tossMarketStatus: 'OPEN'
      }
    }
  ).catch(err => console.error('[TossEngine] Error normalizing toss odds:', err.message));

  // Immediate check & sweep on startup
  updateTossOdds();

  // Poll every 10 seconds:
  // - Closes toss market for any match reaching start time or going live
  // - Keeps toss odds active and alive ONLY for upcoming matches
  pollInterval = setInterval(updateTossOdds, 10000);
}

function destroyTossOddsEngine() {
  if (pollInterval) clearInterval(pollInterval);
}

module.exports = { initTossOddsEngine, destroyTossOddsEngine, settleToss, isMatchStartedOrLive };
