const Bet = require('../models/Bet');
const User = require('../models/User');

const { distributeProfitLoss } = require('./hierarchyService');

/**
 * settleMatch
 * @param {string} matchId - The unique ID of the match
 * @param {string} winningTeam - The team that won, or 'REFUND'/'VOID' for no result/ties
 * @param {object} io - Socket.io instance for notifications
 */
const settleMatch = async (matchId, winningTeam, io) => {
    try {
        console.log(`[SETTLEMENT] Beginning settlement for matchId: ${matchId}`);
        console.log(`[SETTLEMENT] Declared Result/Winner: ${winningTeam}`);

        // Find all active match_odds bets for this match (exclude toss bets which are settled separately)
        const activeBets = await Bet.find({ matchId, status: { $in: ['pending', 'MATCHED'] }, marketType: { $ne: 'toss' } });

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

            let runnerWon = false;
            if (bet.marketType === 'tied_match') {
                if (normWinning === 'tie') {
                    runnerWon = normRunner.includes('yes');
                } else {
                    runnerWon = normRunner.includes('no');
                }
            } else {
                runnerWon = (normRunner === normWinning);
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

            if (isWin) {
                // User Won:
                // For BACK: profit = stake * (odds - 1). Return stake + netProfit (after 5% commission on net profit)
                // For LAY: profit = stake. Return liability + netProfit (after 5% commission on net profit)
                const profit = isBack ? Math.round(bet.stake * (bet.odds - 1)) : bet.stake;
                const commission = Math.round(profit * 0.05);
                const netProfit = profit - commission;
                const netPayout = liability + netProfit;
                
                const user = await User.findOneAndUpdate(
                    { username: bet.userId },
                    { $inc: { walletBalance: netPayout } },
                    { new: true }
                );

                bet.status = 'won';
                bet.payout = netPayout;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // House Loss = (Net Payout for user) - (Initial Liability already deducted)
                const houseLoss = -(netPayout - liability);
                await distributeProfitLoss(bet.userId, houseLoss, { matchName: bet.matchName, selection: bet.runner });

                console.log(`[BET WIN] User: ${bet.userId} won net profit ${netProfit} (Total Payout: ${netPayout}, Comm: ${commission})`);

                if (io) {
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'won',
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
                bet.payout = 0;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // House Profit = Initial Liability
                await distributeProfitLoss(bet.userId, liability, { matchName: bet.matchName, selection: bet.runner });

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

const Match = require('../models/Match');
module.exports = { settleMatch };
