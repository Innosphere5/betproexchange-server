const Bet = require('../models/Bet');
const User = require('../models/User');

const Match = require('../models/Match');
const { distributeProfitLoss } = require('./hierarchyService');

/**
 * Numberline Rate Adjustment Algorithm:
 * - When a user placed a bet at rate 7:
 *     - If the market rate goes UP to 9, 10, 11 (rate >= 8):
 *       user gets the amount at the 8 rate (not 9, 10, 11).
 *     - If the market rate goes DOWN like 6, 4, 3, 2, 1 (rate <= 6):
 *       user gets the amount of 5.
 *     - If the market rate stays at 7:
 *       user gets rate 7.
 * - Otherwise (for any placed rate other than 7):
 *     - Works normally as current.
 */
function getEffectiveSettlementRate(placedRate, marketRate) {
    const placed = Number(placedRate);
    if (placed === 7 && marketRate != null && !isNaN(marketRate)) {
        const current = Number(marketRate);
        if (current >= 8) {
            return 8; // Capped at rate 8 if rate goes 9, 10, 11...
        } else if (current <= 6) {
            return 5; // Floored at rate 5 if rate goes down 6, 4, 3, 2, 1...
        } else {
            return current;
        }
    }
    return placed;
}

/**
 * settleMatch
 * @param {string} matchId - The unique ID of the match
 * @param {string} winningTeam - The team that won, or 'REFUND'/'VOID' for no result/ties
 * @param {object} io - Socket.io instance for notifications
 * @param {object} options - Optional context { marketRates, currentRate }
 */
const settleMatch = async (matchId, winningTeam, io, options = {}) => {
    try {
        console.log(`[SETTLEMENT] Beginning settlement for matchId: ${matchId}`);
        console.log(`[SETTLEMENT] Declared Result/Winner: ${winningTeam}`);

        const altMatchId = String(matchId).startsWith('id') ? String(matchId).replace(/^id/, '') : ('id' + String(matchId));
        const matchIdList = [matchId, altMatchId];

        // Fetch match to resolve runner market rates if needed
        const match = await Match.findOne({ matchId: { $in: matchIdList } });

        // Find all active bets for this match (only match outcome markets: match_odds, bookmaker, tied_match)
        const activeBets = await Bet.find({ 
            matchId: { $in: matchIdList }, 
            status: { $in: ['pending', 'MATCHED'] }, 
            marketType: { $in: ['match_odds', 'bookmaker', 'tied_match', null, undefined, ''] } 
        });

        if (activeBets.length === 0) {
            console.log(`[SETTLEMENT] No pending bets found for matchId: ${matchId}`);
            return;
        }

        const normWinning = String(winningTeam || '').trim().toLowerCase();
        const isRefund = ['refund', 'void'].includes(normWinning) || (normWinning === 'tie' && !activeBets.some(b => b.marketType === 'tied_match'));

        for (const bet of activeBets) {
            // Idempotency check (extra safety)
            if (!['pending', 'MATCHED'].includes(bet.status)) continue;

            const isBack = bet.type === 'back';
            const normRunner = String(bet.runner || '').trim().toLowerCase();
            const cleanRunner = normRunner.replace(/\s+bm$/i, '').trim();
            const cleanWinning = normWinning.replace(/\s+bm$/i, '').trim();

            let runnerWon = false;
            if (bet.marketType === 'tied_match') {
                if (normWinning === 'tie') {
                    runnerWon = normRunner.includes('yes');
                } else {
                    runnerWon = normRunner.includes('no');
                }
            } else {
                runnerWon = (cleanRunner === cleanWinning) || 
                            (cleanWinning && cleanRunner && (cleanRunner.includes(cleanWinning) || cleanWinning.includes(cleanRunner)));
            }

            const isWin = isBack ? runnerWon : !runnerWon;
            const liability = (!isBack && bet.odds > 1) ? Math.round(bet.stake * (bet.odds - 1)) : bet.stake;

            if (isRefund) {
                // REFUND Condition: Return the liability to the user
                const user = await User.findOneAndUpdate(
                    { username: bet.userId },
                    { $inc: { walletBalance: liability } },
                    { new: true }
                );

                bet.status = 'cancelled';
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                console.log(`[BET REFUND] User: ${bet.userId} refunded ${liability} for ${bet.matchName}.`);

                if (io && user) {
                    io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'cancelled',
                        message: `Match Void: ${liability} refunded`,
                        matchName: bet.matchName
                    });
                }
                continue;
            }

            // Resolve current/final market rate for this runner
            let currentMarketRate = options?.marketRates?.[bet.runner] || options?.currentRate || bet.closingOdds || bet.currentOdds;
            if (currentMarketRate == null && match) {
                const isTeamA = match.teamA && cleanRunner.includes(match.teamA.toLowerCase().trim());
                const isTeamB = match.teamB && cleanRunner.includes(match.teamB.toLowerCase().trim());
                if (isTeamA) {
                    currentMarketRate = isBack ? (match.backOddsA || match.bookmakerBackA) : (match.layOddsA || match.bookmakerLayA);
                } else if (isTeamB) {
                    currentMarketRate = isBack ? (match.backOddsB || match.bookmakerBackB) : (match.layOddsB || match.bookmakerLayB);
                }
            }

            // Apply rate-7 numberline algorithm
            const effectiveOdds = getEffectiveSettlementRate(bet.odds, currentMarketRate);

            if (isWin) {
                // User Won:
                // For BACK: profit = stake * (effectiveOdds - 1). Return stake + netProfit (after 5% commission on net profit)
                // For LAY: profit = stake. Return liability + netProfit (after 5% commission on net profit)
                const profit = isBack ? Math.round(bet.stake * (effectiveOdds - 1)) : bet.stake;
                const commission = Math.round(profit * 0.05);
                const netProfit = profit - commission;
                const netPayout = liability + netProfit;
                
                const user = await User.findOneAndUpdate(
                    { username: bet.userId },
                    { $inc: { walletBalance: netPayout } },
                    { new: true }
                );

                bet.status = 'won';
                bet.effectiveOdds = effectiveOdds;
                bet.closingOdds = currentMarketRate != null ? Number(currentMarketRate) : null;
                bet.payout = netPayout;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // House Loss = (Net Payout for user) - (Initial Liability already deducted)
                const houseLoss = -(netPayout - liability);
                await distributeProfitLoss(bet.userId, houseLoss, { matchName: bet.matchName, selection: bet.runner }, io);

                console.log(`[BET WIN] User: ${bet.userId} won net profit ${netProfit} @ effectiveRate ${effectiveOdds} (Placed: ${bet.odds}, Market: ${currentMarketRate}, Payout: ${netPayout})`);

                if (io) {
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'won',
                        effectiveRate: effectiveOdds,
                        payout: netPayout,
                        matchName: bet.matchName
                    });
                    
                    if (user) {
                        io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
                    }
                }
            } else {
                // User Lost: Liability is already deducted
                bet.status = 'lost';
                bet.effectiveOdds = effectiveOdds;
                bet.closingOdds = currentMarketRate != null ? Number(currentMarketRate) : null;
                bet.payout = 0;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // House Profit = Initial Liability
                await distributeProfitLoss(bet.userId, liability, { matchName: bet.matchName, selection: bet.runner }, io);

                console.log(`[BET LOSE] User: ${bet.userId} lost liability of ${liability}`);

                if (io) {
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'lost',
                        payout: 0,
                        matchName: bet.matchName
                    });
                }
            }
        }
        
        console.log(`[SETTLEMENT] Finished resolving ${activeBets.length} bets for matchId: ${matchId}`);
    } catch (error) {
        console.error(`[SETTLEMENT ERROR] Failed to settle matchId ${matchId}:`, error);
    }
};

module.exports = { settleMatch, getEffectiveSettlementRate };
