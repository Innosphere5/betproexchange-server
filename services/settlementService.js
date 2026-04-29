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
                // User Won: 
                // grossWin = stake * odds
                // commission = 3% of grossWin
                // netWin = grossWin - commission
                const grossWin = bet.stake * bet.odds;
                const commission = grossWin * 0.03;
                const netWin = grossWin - commission;
                
                const user = await User.findOneAndUpdate(
                    { username: bet.userId },
                    { $inc: { walletBalance: netWin } },
                    { new: true }
                );

                bet.status = 'won';
                bet.payout = netWin;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // House Loss = (Net Win for user) - (Initial Stake already deducted)
                const houseLoss = -(netWin - bet.stake);
                await distributeProfitLoss(bet.userId, houseLoss);

                console.log(`[BET WIN] User: ${bet.userId} won ${netWin.toFixed(2)} (Gross: ${grossWin}, Comm: ${commission.toFixed(2)})`);

                if (io) {
                    io.emit('bet_settled', {
                        betId: bet._id,
                        status: 'won',
                        payout: netWin,
                        matchName: bet.matchName
                    });
                    
                    if (user) {
                        io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
                    }
                }
            } else {
                // User Lost: Stake is already deducted
                bet.status = 'lost';
                bet.payout = 0;
                bet.result = winningTeam;
                bet.settledAt = new Date();
                await bet.save();

                // House Profit = Initial Stake
                await distributeProfitLoss(bet.userId, bet.stake);

                console.log(`[BET LOSE] User: ${bet.userId} lost stake of ${bet.stake}`);

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
