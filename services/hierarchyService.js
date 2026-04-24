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
        let totalDistributedAmount = 0;
        let rootUser = null;

        console.log(`[HIERARCHY] Starting Absolute Share distribution of ${amount} from bettor ${username}`);

        // Traverse up the parent chain
        while (current.parentId) {
            const parent = await User.findById(current.parentId);
            if (!parent) break;

            // In this Absolute Share system:
            // Every manager gets exactly their parent.share % of the original amount.
            // Example: Master (50%), Admin (30%), SuperAdmin (Remainder)
            // Bettor loses 1000 -> Master gets 500, Admin gets 300, SuperAdmin gets 200.
            
            const isRoot = !parent.parentId;
            if (isRoot) {
                rootUser = parent;
                break; // Root is handled last with the remainder
            }

            const parentSharePercent = parent.share || 0;
            
            if (parentSharePercent > 0) {
                const netAmountForParent = (parentSharePercent / 100) * amount;

                if (netAmountForParent !== 0) {
                    await User.findByIdAndUpdate(
                        parent._id,
                        { $inc: { walletBalance: netAmountForParent } }
                    );

                    totalDistributedAmount += netAmountForParent;

                    // Record transaction for the parent
                    await Transaction.create({
                        userId: parent.username,
                        amount: netAmountForParent,
                        type: 'COMMISSION_SHARE',
                        description: `Commission from ${username} (${parentSharePercent}% share)`,
                        performedBy: 'SYSTEM'
                    });

                    console.log(`[HIERARCHY] Distributed ${netAmountForParent.toFixed(2)} to ${parent.role} ${parent.username} (${parentSharePercent}% share)`);
                }
            }

            current = parent;
        }

        // The root (SuperAdmin) gets the remainder
        if (rootUser) {
            const remainder = amount - totalDistributedAmount;
            
            if (remainder !== 0) {
                await User.findByIdAndUpdate(
                    rootUser._id,
                    { $inc: { walletBalance: remainder } }
                );

                // Record transaction for the root
                await Transaction.create({
                    userId: rootUser.username,
                    amount: remainder,
                    type: 'COMMISSION_SHARE',
                    description: `House Remainder from ${username}`,
                    performedBy: 'SYSTEM'
                });

                console.log(`[HIERARCHY] Distributed remainder ${remainder.toFixed(2)} to SuperAdmin ${rootUser.username}`);
            }
        }
    } catch (err) {
        console.error('[HIERARCHY ERROR] Failed to distribute P/L:', err);
    }
}

module.exports = { distributeProfitLoss };
