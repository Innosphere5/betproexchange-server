const User = require('../models/User');
const Transaction = require('../models/Transaction');

/**
 * Distribute profit/loss up the hierarchy chain.
 * @param {string} username - The username of the bettor who placed the bet.
 * @param {number} amount - The amount to distribute (positive for house profit, negative for house loss).
 */
async function distributeProfitLoss(username, amount) {
    if (amount === 0) return;

    try {
        const bettor = await User.findOne({ username });
        if (!bettor) return;

        let current = bettor;
        let remaining = amount;
        
        console.log(`[HIERARCHY] Starting Chain Distribution of ${amount} from bettor ${username}`);

        // Traverse up the parent chain
        while (current.parentId && remaining !== 0) {
            const parent = await User.findById(current.parentId);
            if (!parent) break;

            // Chain Logic:
            // shareAmount = remaining * (current.share / 100)
            const currentSharePercent = current.share || 0;
            const shareAmount = (currentSharePercent / 100) * remaining;

            if (shareAmount !== 0) {
                await User.findByIdAndUpdate(
                    parent._id,
                    { $inc: { walletBalance: shareAmount } }
                );

                // Record transaction for the parent
                await Transaction.create({
                    userId: parent.username,
                    amount: shareAmount,
                    type: 'COMMISSION_SHARE',
                    description: `Share from ${current.role} ${current.username} (${currentSharePercent}%)`,
                    performedBy: 'SYSTEM'
                });

                console.log(`[HIERARCHY] Distributed ${shareAmount.toFixed(2)} to ${parent.role} ${parent.username} (${currentSharePercent}% of remaining)`);
                
                remaining -= shareAmount;
            }

            // Move up
            current = parent;

            // If the next parent is the top-level (SuperAdmin), they get the final remainder
            if (!current.parentId) {
                break;
            }
        }

        // The final remaining amount goes to the top-level user (SuperAdmin)
        if (remaining !== 0) {
            await User.findByIdAndUpdate(
                current._id,
                { $inc: { walletBalance: remaining } }
            );

            await Transaction.create({
                userId: current.username,
                amount: remaining,
                type: 'COMMISSION_SHARE',
                description: `Final House Remainder from ${username}`,
                performedBy: 'SYSTEM'
            });

            console.log(`[HIERARCHY] Distributed final remainder ${remaining.toFixed(2)} to ${current.role} ${current.username}`);
        }
    } catch (err) {
        console.error('[HIERARCHY ERROR] Failed to distribute P/L:', err);
    }
}

module.exports = { distributeProfitLoss };
