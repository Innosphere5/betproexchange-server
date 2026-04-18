const Bet = require('../models/Bet');
const User = require('../models/User');

const settleMatch = async (matchName, winningTeam, io) => {
    try {
        console.log(`[SETTLEMENT] Beginning settlement for match: ${matchName}`);
        console.log(`[SETTLEMENT] Declared Winner: ${winningTeam}`);

        // Find all active bets for this match
        const activeBets = await Bet.find({ matchName, status: 'MATCHED' });

        if (activeBets.length === 0) {
            console.log(`[SETTLEMENT] No active bets found for ${matchName}`);
            return;
        }

        for (const bet of activeBets) {
            const isBack = bet.type === 'back';
            const runnerWon = bet.runner === winningTeam;
            
            // Winning Condition: 
            // - Back bet wins if runner wins.
            // - Lay bet wins if runner loses (runner !== winningTeam).
            const isWin = isBack ? runnerWon : !runnerWon;

            if (isWin) {
                // User Won
                const payout = bet.stake * bet.odds;
                
                // Atomic update to wallet
                const user = await User.findOneAndUpdate(
                    { userId: bet.userId },
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
                        io.emit('wallet_updated', user.walletBalance);
                    }
                }
            } else {
                // User Lost
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
        
        console.log(`[SETTLEMENT] Finished resolving ${activeBets.length} bets for ${matchName}`);
    } catch (error) {
        console.error(`[SETTLEMENT ERROR] Failed to settle ${matchName}:`, error);
    }
};

module.exports = { settleMatch };
