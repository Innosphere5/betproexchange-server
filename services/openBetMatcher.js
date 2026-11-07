const Bet = require('../models/Bet');
const Match = require('../models/Match');
const User = require('../models/User');

function matchesTeamName(runnerStr, teamStr) {
  if (!runnerStr || !teamStr) return false;
  const r = runnerStr.trim().toLowerCase();
  const t = teamStr.trim().toLowerCase();
  return r === t || r.includes(t) || t.includes(r);
}

/**
 * Resolves current active market odds for a given runner, side (back/lay), and marketType
 */
function getActiveMarketOdds(matchInDb, runner, betType, marketType) {
  if (!matchInDb) return null;
  const normRunner = String(runner || '').trim().toLowerCase();
  const type = (betType || 'back').toLowerCase();
  const mType = (marketType || 'match_odds').toLowerCase();

  // 1. Toss
  if (mType === 'toss') {
    return type === 'lay' ? 2.02 : 1.98;
  }

  const teamAName = String(matchInDb.teamA || '').trim();
  const teamBName = String(matchInDb.teamB || '').trim();
  const isTeamA = matchesTeamName(normRunner, teamAName);
  const isTeamB = matchesTeamName(normRunner, teamBName);

  // 2. Bookmaker
  if (mType === 'bookmaker') {
    if (isTeamA) {
      if (type === 'back') return Number(matchInDb.bookmakerBackA || matchInDb.backOddsA || 0);
      return Number(matchInDb.bookmakerLayA || matchInDb.layOddsA || 0);
    } else if (isTeamB) {
      if (type === 'back') return Number(matchInDb.bookmakerBackB || matchInDb.backOddsB || 0);
      return Number(matchInDb.bookmakerLayB || matchInDb.layOddsB || 0);
    }
    return null;
  }

  // 3. Figure
  if (mType === 'figure' && Array.isArray(matchInDb.figureMarkets)) {
    const digitMatch = normRunner.match(/digit\s*(\d+)/i);
    if (digitMatch) {
      const digitNum = parseInt(digitMatch[1], 10);
      for (const fig of matchInDb.figureMarkets) {
        const found = fig.digits?.find(d => d.digit === digitNum);
        if (found && found.odds) return Number(found.odds);
      }
    }
    return 8.85;
  }

  // 4. Fancy
  if (mType === 'fancy' && Array.isArray(matchInDb.fancyMarkets)) {
    const item = matchInDb.fancyMarkets.find(f => normRunner.includes(String(f.name).toLowerCase()) || String(f.name).toLowerCase().includes(normRunner));
    if (item) {
      return type === 'lay' ? Number(item.layPrice || 1.95) : Number(item.backPrice || 1.95);
    }
    return 1.95;
  }

  // 5. Even / Odd
  if (mType === 'even_odd' && Array.isArray(matchInDb.evenOddMarkets)) {
    const item = matchInDb.evenOddMarkets.find(eo => normRunner.includes(String(eo.name).toLowerCase()) || String(eo.name).toLowerCase().includes(normRunner));
    if (item) {
      return type === 'lay' ? Number(item.layPrice || 0) : Number(item.backPrice || 0);
    }
    return null;
  }

  // 6. Tied Match
  if (mType === 'tied_match' && matchInDb.tiedMatchMarket?.runners) {
    const isYes = normRunner.includes('yes');
    const runnerItem = matchInDb.tiedMatchMarket.runners.find(r => {
      const rName = String(r.name).toLowerCase();
      return isYes ? rName === 'yes' : rName === 'no';
    });
    if (runnerItem) {
      const oddsList = type === 'back' ? runnerItem.backOdds : runnerItem.layOdds;
      const best = oddsList?.[0]?.price;
      return best ? Number(best) : null;
    }
    return null;
  }

  // 7. Match Odds (standard)
  if (isTeamA) {
    return type === 'back' ? Number(matchInDb.backOddsA || 0) : Number(matchInDb.layOddsA || 0);
  } else if (isTeamB) {
    return type === 'back' ? Number(matchInDb.backOddsB || 0) : Number(matchInDb.layOddsB || 0);
  }

  return null;
}

/**
 * Checks open bets for a match and matches any whose odds criteria are met by live market odds.
 */
async function checkAndMatchOpenBets(matchId, io, liveMatchDoc = null) {
  if (!matchId) return 0;
  const cleanId = String(matchId).replace(/^id/, '');
  const altId = `id${cleanId}`;

  const openBets = await Bet.find({
    matchId: { $in: [matchId, cleanId, altId] },
    status: { $in: ['OPEN', 'open', 'unmatched'] }
  });

  if (!openBets || openBets.length === 0) return 0;

  let match = liveMatchDoc;
  if (!match || !match.backOddsA) {
    match = await Match.findOne({ matchId: { $in: [matchId, cleanId, altId] } });
  }
  if (!match) return 0;

  let matchedCount = 0;

  for (const bet of openBets) {
    const currentMarketOdds = getActiveMarketOdds(match, bet.runner, bet.type, bet.marketType);
    if (!currentMarketOdds || isNaN(currentMarketOdds) || currentMarketOdds <= 1) continue;

    const betOdds = Number(bet.odds);
    const isBack = (bet.type || 'back').toLowerCase() === 'back';
    let shouldMatch = false;

    // BACK BET: Matches if live market back odds reaches or exceeds user's requested odds,
    // or if the market odds match the user's requested odds within small rounding tolerance
    if (isBack) {
      if (currentMarketOdds >= betOdds || Math.abs(currentMarketOdds - betOdds) <= 0.001) {
        shouldMatch = true;
      }
    } else {
      // LAY BET: Matches if live market lay odds drops to or is below user's requested odds,
      // or if the market odds match user's requested odds
      if (currentMarketOdds <= betOdds || Math.abs(currentMarketOdds - betOdds) <= 0.001) {
        shouldMatch = true;
      }
    }

    if (shouldMatch) {
      bet.status = 'MATCHED';
      bet.effectiveOdds = betOdds;
      await bet.save();
      matchedCount++;

      console.log(`[OPEN BET MATCHED] Bet ${bet._id} (${bet.type.toUpperCase()}) for user ${bet.userId} matched at odds ${betOdds} (Market: ${currentMarketOdds}) on ${bet.matchName}`);

      if (io) {
        io.emit('open_bet_matched', {
          betId: bet._id,
          matchId: bet.matchId,
          runner: bet.runner,
          odds: bet.odds,
          stake: bet.stake,
          type: bet.type,
          userId: bet.userId,
          status: 'MATCHED'
        });
        io.emit('bet_placed', { matchId: bet.matchId, bet });
      }
    }
  }

  return matchedCount;
}

/**
 * Expire unmatched open bets when a match concludes or settles.
 * "otherwise it goes to garbage and user get the amount"
 * Unmatched open bets are cancelled and full liability is refunded back to the user's wallet.
 */
async function expireAndRefundOpenBets(matchId, io, reason = 'MATCH_CONCLUDED') {
  if (!matchId) return 0;
  const cleanId = String(matchId).replace(/^id/, '');
  const altId = `id${cleanId}`;

  const openBets = await Bet.find({
    matchId: { $in: [matchId, cleanId, altId] },
    status: { $in: ['OPEN', 'open', 'unmatched', 'pending'] }
  });

  if (!openBets || openBets.length === 0) return 0;

  let refundedCount = 0;

  for (const bet of openBets) {
    const isBack = (bet.type || 'back').toLowerCase() === 'back';
    const liability = (!isBack && bet.odds > 1) ? Math.round(bet.stake * (bet.odds - 1)) : bet.stake;

    const user = await User.findOneAndUpdate(
      { username: bet.userId },
      { $inc: { walletBalance: liability } },
      { new: true }
    );

    bet.status = 'CANCELLED';
    bet.result = 'EXPIRED_UNMATCHED';
    bet.settledAt = new Date();
    await bet.save();
    refundedCount++;

    console.log(`[OPEN BET GARBAGE REFUND] User ${bet.userId} refunded ${liability} for unmatched open bet on ${bet.matchName} (${reason})`);

    if (io) {
      if (user) {
        io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
      }
      io.emit('bet_settled', {
        betId: bet._id,
        status: 'cancelled',
        message: `Unmatched open bet expired & refunded: ${liability}`,
        matchName: bet.matchName
      });
    }
  }

  return refundedCount;
}

/**
 * Allows a user to cancel their own open bet before it matches, refunding stake/liability immediately.
 */
async function cancelUserOpenBet(betId, username, io) {
  const bet = await Bet.findOne({ _id: betId, userId: username });
  if (!bet) {
    throw new Error('Bet not found');
  }

  const isEligible = ['OPEN', 'open', 'unmatched'].includes(bet.status);
  if (!isEligible) {
    throw new Error('Only open/unmatched bets can be cancelled');
  }

  const isBack = (bet.type || 'back').toLowerCase() === 'back';
  const liability = (!isBack && bet.odds > 1) ? Math.round(bet.stake * (bet.odds - 1)) : bet.stake;

  const user = await User.findOneAndUpdate(
    { username: bet.userId },
    { $inc: { walletBalance: liability } },
    { new: true }
  );

  bet.status = 'CANCELLED';
  bet.result = 'USER_CANCELLED';
  bet.settledAt = new Date();
  await bet.save();

  console.log(`[USER CANCEL OPEN BET] User ${username} cancelled open bet ${betId}, refunded ${liability}`);

  if (io && user) {
    io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
    io.emit('bet_settled', {
      betId: bet._id,
      status: 'cancelled',
      message: `Open bet cancelled. ${liability} refunded.`,
      matchName: bet.matchName
    });
  }

  return { success: true, refunded: liability, balance: user?.walletBalance || 0 };
}

module.exports = {
  checkAndMatchOpenBets,
  expireAndRefundOpenBets,
  cancelUserOpenBet,
  getActiveMarketOdds
};

