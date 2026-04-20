const Bet = require('../models/Bet');
const User = require('../models/User');

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

        // Find all active bets for this match
        const activeBets = await Bet.find({ matchId, status: 'MATCHED' });

        if (activeBets.length === 0) {
            console.log(`[SETTLEMENT] No active bets found for matchId: ${matchId}`);
            return;
        }

        const isRefund = winningTeam === 'REFUND' || winningTeam === 'VOID' || winningTeam === 'TIE';

        for (const bet of activeBets) {
            if (isRefund) {
                // REFUND Condition: Return the stake to the user
                const user = await User.findOneAndUpdate(
                    { username: bet.userId }, // Bet model uses userId which matches username in User model
                    { $inc: { walletBalance: bet.stake } },
                    { new: true }
                );

                bet.status = 'CANCELLED';
                await bet.save();

                console.log(`[BET REFUND] User: ${bet.userId} refunded ${bet.stake} for ${bet.matchName}.`);

                if (io && user) {
                    io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
                    io.emit('bet_notification', {
                        status: 'CANCELLED',
                        message: `Match Void: ${bet.stake} refunded for ${bet.matchName}`,
                        matchName: bet.matchName
                    });
                }
                continue;
            }

            const isBack = bet.type === 'back';
            const runnerWon = bet.runner === winningTeam;
            
            // Winning Condition: 
            // - Back bet wins if runner wins.
            // - Lay bet wins if runner loses (runner !== winningTeam).
            const isWin = isBack ? runnerWon : !runnerWon;

            if (isWin) {
                // User Won: Payout is stake * odds
                const payout = bet.stake * bet.odds;
                
                const user = await User.findOneAndUpdate(
                    { username: bet.userId },
                    { $inc: { walletBalance: payout } },
                    { new: true }
                );

                bet.status = 'WIN';
                await bet.save();

                console.log(`[BET WIN] User: ${bet.userId} won ${payout} on ${bet.runner} (${bet.type}).`);

                if (io) {
                    io.emit('bet_notification', {
                        status: 'WIN',
                        amount: payout,
                        matchName: bet.matchName,
                        runner: bet.runner,
                        type: bet.type
                    });
                    
                    if (user) {
                        io.emit('wallet_updated', { userId: user.username, balance: user.walletBalance });
                    }
                }
            } else {
                // User Lost: Stake is already deducted at placement, so just update status
                bet.status = 'LOSE';
                await bet.save();

                console.log(`[BET LOSE] User: ${bet.userId} lost stake of ${bet.stake} on ${bet.runner} (${bet.type}).`);

                if (io) {
                    io.emit('bet_notification', {
                        status: 'LOSE',
                        amount: bet.stake,
                        matchName: bet.matchName,
                        runner: bet.runner,
                        type: bet.type
                    });
                }
            }
        }
        
        console.log(`[SETTLEMENT] Finished resolving ${activeBets.length} bets for matchId: ${matchId}`);
    } catch (error) {
        console.error(`[SETTLEMENT ERROR] Failed to settle matchId ${matchId}:`, error);
    }
};

module.exports = { settleMatch };
