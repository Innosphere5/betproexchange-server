const User = require('../models/User');
const Transaction = require('../models/Transaction');

/**
 * Distribute profit/loss up the hierarchy chain using Fixed Share logic.
 * @param {string} username - The username of the bettor.
 * @param {number} amount - Total amount to distribute (House Profit +ve, House Loss -ve).
 * @param {boolean} isCasino - Whether this is a casino bet (affects commission logic).
 */
async function distributePL(username, amount, isCasino = false) {
    if (amount === 0) return;

    try {
        const bettor = await User.findOne({ username });
        if (!bettor) return;

        // Find the chain of ancestors
        let chain = [];
        let current = bettor;
        while (current.parentId) {
            const parent = await User.findById(current.parentId);
            if (!parent) break;
            chain.push(parent);
            current = parent;
        }

        if (chain.length === 0) {
            console.log(`[HIERARCHY] No parents found for ${username}. Distribution skipped.`);
            return;
        }

        console.log(`[HIERARCHY] Starting ${isCasino ? 'CASINO' : 'CRICKET'} Distribution of ${amount.toFixed(2)} for ${username}`);

        let childShare = 0;
        let distributedSoFar = 0;

        // Casino Profit Commission Logic (5% taken from house profit)
        let commissionAmount = 0;
        if (isCasino && amount > 0) {
            commissionAmount = amount * 0.05;
            console.log(`[HIERARCHY] Casino Commission (5%): ${commissionAmount.toFixed(2)}`);
        }

        for (let i = 0; i < chain.length; i++) {
            const user = chain[i];
            const isTopLevel = (i === chain.length - 1);
            
            // Determine my share percentage
            // Top level always effectively has 100% (or the remainder)
            let mySharePercent = isTopLevel ? 100 : (user.share || 0);
            
            // Share math: Earnings = Total * (MyShare - ChildShare) / 100
            let shareDiff = mySharePercent - childShare;
            if (shareDiff < 0) shareDiff = 0; // Safety

            let earnings = (shareDiff / 100) * amount;

            // If this is the top level and it's casino profit, subtract the 5% commission from SuperAdmin's earnings
            if (isTopLevel && commissionAmount > 0) {
                console.log(`[HIERARCHY] Deducting commission from SuperAdmin ${user.username} (${earnings.toFixed(2)} -> ${(earnings - commissionAmount).toFixed(2)})`);
                earnings -= commissionAmount;
                
                // Optional: Record the commission separately
                await Transaction.create({
                    userId: user.username,
                    amount: commissionAmount,
                    type: 'PLATFORM_COMMISSION',
                    description: `Casino Platform Commission from ${username}`,
                    performedBy: 'SYSTEM'
                });
            }

            if (earnings !== 0) {
                await User.findByIdAndUpdate(user._id, { $inc: { walletBalance: earnings } });
                
                await Transaction.create({
                    userId: user.username,
                    amount: earnings,
                    type: 'COMMISSION_SHARE',
                    description: `${isCasino ? 'Casino' : 'Cricket'} Share from ${username} (${shareDiff}%)`,
                    performedBy: 'SYSTEM'
                });

                console.log(`[HIERARCHY] Distributed ${earnings.toFixed(2)} to ${user.role} ${user.username} (${shareDiff}%)`);
                distributedSoFar += earnings;
            }

            childShare = mySharePercent;
        }

        console.log(`[HIERARCHY] Distribution complete for ${username}. Total Distributed (excl. comm): ${distributedSoFar.toFixed(2)}`);
    } catch (err) {
        console.error('[HIERARCHY ERROR] Failed to distribute P/L:', err);
    }
}

/**
 * distributeProfitLoss - Legacy wrapper for Cricket/General
 */
async function distributeProfitLoss(username, amount) {
    return distributePL(username, amount, false);
}

/**
 * distributeCasinoPL - Specific wrapper for Casino
 */
async function distributeCasinoPL(username, amount) {
    return distributePL(username, amount, true);
}

module.exports = { distributeProfitLoss, distributeCasinoPL };
