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

        // Find all pending bets for this match
        const activeBets = await Bet.find({ matchId, status: 'pending' });

        if (activeBets.length === 0) {
            console.log(`[SETTLEMENT] No pending bets found for matchId: ${matchId}`);
            return;
        }

        const isRefund = winningTeam === 'REFUND' || winningTeam === 'VOID' || winningTeam === 'TIE';

        for (const bet of activeBets) {
            // Idempotency check (extra safety)
            if (bet.status !== 'pending') continue;

            if (isRefund) {
                // REFUND Condition: Return the stake to the user
                const user = await User.findOneAndUpdate(
                    { username: bet.userId },
                    { $inc: { walletBalance: bet.stake } },
                    { new: true }
                );

                bet.status = 'cancelled';
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                console.log(`[BET REFUND] User: ${bet.userId} refunded ${bet.stake} for ${bet.matchName}.`);

                if (io && user) {
                    io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'cancelled',
                        message: `Match Void: ${bet.stake} refunded`,
                        matchName: bet.matchName
                    });
                }
                continue;
            }

            const isBack = bet.type === 'back';
            const runnerWon = bet.runner === winningTeam;
            const isWin = isBack ? runnerWon : !runnerWon;

            if (isWin) {
                // User Won: payout = stake + (profit * 0.97)
                const profit = bet.stake * (bet.odds - 1);
                const netProfit = profit * 0.97;
                const payoutAmount = bet.stake + netProfit;
                
                const user = await User.findOneAndUpdate(
                    { username: bet.userId },
                    { $inc: { walletBalance: payoutAmount } },
                    { new: true }
                );

                bet.status = 'won';
                bet.payout = payoutAmount;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // Distribute House Loss up the chain
                await distributeProfitLoss(bet.userId, -netProfit);

                console.log(`[BET WIN] User: ${bet.userId} won ${payoutAmount} on ${bet.runner}.`);

                if (io) {
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'won',
                        payout: payoutAmount,
                        matchName: bet.matchName
                    });
                    
                    if (user) {
                        io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
                    }
                }
            } else {
                // User Lost: Stake is already deducted, so just update status
                bet.status = 'lost';
                bet.payout = 0;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // Distribute House Profit up the chain
                await distributeProfitLoss(bet.userId, bet.stake);

                console.log(`[BET LOSE] User: ${bet.userId} lost stake of ${bet.stake} on ${bet.runner}.`);

                if (io) {
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'lost',
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
