/**
 * Toss Odds Engine
 * 
 * Generates synthetic toss odds for cricket matches.
 * 
 * Logic:
 * - Toss is a coin flip → odds are ~2.00 (50/50) with slight exchange-style spread
 * - Back odds: 1.90–2.00, Lay odds: 2.00–2.10 (tight spread like real exchanges)
 * - Depth volumes are synthetic but realistic (50–500 range)
 * - Toss market is OPEN only for upcoming/live matches where toss hasn't been decided
 * - Once tossWinner is set, market closes and toss bets are settled
 * 
 * MaxBet: 2M (enforced on frontend, not in odds engine)
 */

const Match = require('../models/Match');
const Bet = require('../models/Bet');
const User = require('../models/User');
const { distributeProfitLoss } = require('./hierarchyService');

let ioInstance = null;
let pollInterval = null;

// ─── Toss Odds Generation ──────────────────────────────────────────────────────

/**
 * Generate realistic toss odds with slight random drift
 * Real exchanges show toss odds between 1.90–2.10 with tight back/lay spreads
 */
function generateTossOdds() {
  // Base is 2.00 (50/50), with slight random drift to feel alive
  const drift = (Math.random() - 0.5) * 0.10; // ±0.05

  const backA = Number((1.95 + drift).toFixed(2));
  const layA = Number((backA + 0.04).toFixed(2)); // 4-tick spread

  // Team B is the mirror: if A is favored slightly, B is slightly higher
  const backB = Number((1.95 - drift).toFixed(2));
  const layB = Number((backB + 0.04).toFixed(2));

  return {
    backA: Math.max(1.80, Math.min(2.10, backA)),
    layA: Math.max(1.84, Math.min(2.14, layA)),
    backB: Math.max(1.80, Math.min(2.10, backB)),
    layB: Math.max(1.84, Math.min(2.14, layB)),
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

// ─── Core Polling Loop ─────────────────────────────────────────────────────────

async function updateTossOdds() {
  try {
    // Only generate toss odds for matches that:
    // 1. Are upcoming or live
    // 2. Don't have a toss winner yet
    // 3. Have match odds (meaning they're active on the platform)
    const matches = await Match.find({
      status: { $in: ['upcoming', 'live'] },
      tossWinner: null,
      backOddsA: { $ne: null } // Only if match odds exist (match is active)
    });

    if (matches.length === 0) return;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowEnd = new Date(todayStart.getTime() + 2 * 24 * 60 * 60 * 1000);

    for (const match of matches) {
      const matchStartTime = new Date(match.startTime);
      const isLive = match.status === 'live';
      const isToday = matchStartTime >= todayStart && matchStartTime < tomorrowEnd;

      // Only generate toss odds for today's and tomorrow's matches, or live matches
      if (!isLive && !isToday) continue;

      const odds = generateTossOdds();
      const depth = generateDepth();

      // Check if odds actually changed (avoid unnecessary DB writes)
      const changed = match.tossBackA !== odds.backA ||
                       match.tossLayA !== odds.layA ||
                       match.tossBackB !== odds.backB ||
                       match.tossLayB !== odds.layB;

      if (!changed && match.tossMarketStatus === 'OPEN') continue;

      // Update match in DB
      await Match.findOneAndUpdate(
        { matchId: match.matchId },
        {
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
 * @param {string} tossWinner - The team that won the toss (runner name as stored in bet)
 * @param {object} io - Socket.io instance
 */
async function settleToss(matchId, tossWinner, io) {
  try {
    console.log(`[TossSettlement] Beginning toss settlement for matchId: ${matchId}`);
    console.log(`[TossSettlement] Toss Winner: ${tossWinner}`);

    // Find all pending toss bets for this match
    const tossBets = await Bet.find({ matchId, marketType: 'toss', status: 'pending' });

    if (tossBets.length === 0) {
      console.log(`[TossSettlement] No pending toss bets for matchId: ${matchId}`);
      return;
    }

    const isRefund = tossWinner === 'REFUND' || tossWinner === 'VOID';

    for (const bet of tossBets) {
      if (bet.status !== 'pending') continue;

      if (isRefund) {
        const user = await User.findOneAndUpdate(
          { username: bet.userId },
          { $inc: { walletBalance: bet.stake } },
          { new: true }
        );

        bet.status = 'cancelled';
        bet.result = tossWinner;
        bet.settledAt = new Date();
        await bet.save();

        console.log(`[TossSettlement] REFUND: User ${bet.userId} refunded ${bet.stake}`);

        if (io && user) {
          io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
          io.emit('bet_settled', {
            betId: bet._id,
            status: 'cancelled',
            message: `Toss Void: ${bet.stake} refunded`,
            matchName: bet.matchName
          });
        }
        continue;
      }

      // Determine if user won: 
      // The runner field stores e.g. "England To Win The Toss"
      // The tossWinner is the team name e.g. "England"
      // Check if the bet runner contains the toss winner's team name
      const isBack = bet.type === 'back';
      const runnerWon = bet.runner.includes(tossWinner);
      const isWin = isBack ? runnerWon : !runnerWon;

      if (isWin) {
        const grossWin = bet.stake * bet.odds;
        const commission = grossWin * 0.05;
        const netWin = grossWin - commission;

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

        const houseLoss = -(netWin - bet.stake);
        await distributeProfitLoss(bet.userId, houseLoss, { matchName: bet.matchName, selection: bet.runner });

        console.log(`[TossSettlement] WIN: User ${bet.userId} won ${netWin.toFixed(2)} (Gross: ${grossWin}, Comm: ${commission.toFixed(2)})`);

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

        await distributeProfitLoss(bet.userId, bet.stake, { matchName: bet.matchName, selection: bet.runner });

        console.log(`[TossSettlement] LOSE: User ${bet.userId} lost stake of ${bet.stake}`);

        if (io) {
          io.emit('bet_settled', { betId: bet._id, status: 'lost', payout: 0, matchName: bet.matchName });
        }
      }
    }

    // Close the toss market
    await Match.findOneAndUpdate(
      { matchId },
      { tossMarketStatus: 'CLOSED', tossWinner, lastUpdated: new Date() }
    );

    // Emit toss market closed to UI
    if (io) {
      io.emit('toss_odds_update', { matchId: String(matchId), tossMarketStatus: 'CLOSED', tossWinner });
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

  // Initial run
  updateTossOdds();

  // Poll every 10 seconds to refresh toss odds with slight drift
  pollInterval = setInterval(updateTossOdds, 10000);
}

function destroyTossOddsEngine() {
  if (pollInterval) clearInterval(pollInterval);
}

module.exports = { initTossOddsEngine, destroyTossOddsEngine, settleToss };
