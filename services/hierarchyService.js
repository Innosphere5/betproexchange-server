const User = require('../models/User');
const Transaction = require('../models/Transaction');

/**
 * UNIVERSAL SHARE SPLIT:
 *   85% → SuperAdmin hierarchy (SuperAdmin + Admin + Master)
 *   15% → Book (Platform)
 *
 * Each entity gets their FULL share percentage of the total amount:
 *   - Master gets (master.share)% of total
 *   - Admin gets (admin.share)% of total
 *   - SuperAdmin gets (85 - admin.share - master.share)% of total
 *   - Book gets 15% of total
 *
 * Example: Bettor loses 1000, Admin=30%, Master=20%
 *   Master: 20% × 1000 = 200
 *   Admin:  30% × 1000 = 300
 *   Super:  35% × 1000 = 350  (85 - 30 - 20 = 35)
 *   Book:   15% × 1000 = 150
 *   Total = 1000 ✓
 */

const BOOK_SHARE_PERCENT = 15;
const SUPERADMIN_TOTAL_PERCENT = 85;

/**
 * Distribute profit/loss up the hierarchy chain using Direct Share logic.
 * @param {string} username - The username of the bettor.
 * @param {number} amount - Total amount to distribute (House Profit +ve, House Loss -ve).
 * @param {boolean} isCasino - Whether this is a casino bet (affects commission logic).
 * @param {object} matchDetails - { matchName, selection }
 */
async function distributePL(username, amount, isCasino = false, matchDetails = null) {
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

        let desc = isCasino ? 'Casino Game' : 'Cricket Match';
        if (matchDetails && matchDetails.matchName) {
            desc = `${matchDetails.matchName}${matchDetails.selection ? ` (${matchDetails.selection})` : ''}`;
        }

        // ──────────────────────────────────────────────
        // 1. BOOK SHARE (15% Universal)
        // ──────────────────────────────────────────────
        const bookAmount = (BOOK_SHARE_PERCENT / 100) * amount;
        if (bookAmount !== 0) {
            // Find the SuperAdmin (top of chain) to store book transaction under
            const superAdmin = chain[chain.length - 1];
            
            await Transaction.create({
                userId: superAdmin.username,
                amount: bookAmount,
                type: 'BOOK_SHARE',
                description: desc,
                matchName: matchDetails?.matchName || (isCasino ? 'Casino Game' : 'Cricket Match'),
                selection: matchDetails?.selection,
                category: isCasino ? 'casino' : 'cricket',
                bettor: username,
                downline: 'BOOK',
                performedBy: 'SYSTEM'
            });

            console.log(`[HIERARCHY] Book Share (${BOOK_SHARE_PERCENT}%): ${bookAmount.toFixed(2)}`);
        }

        // ──────────────────────────────────────────────
        // 2. HIERARCHY DISTRIBUTION (85% split among chain)
        // ──────────────────────────────────────────────
        // Casino Profit Commission Logic (5% taken from house profit)
        let commissionAmount = 0;
        if (isCasino && amount > 0) {
            commissionAmount = amount * 0.05;
            console.log(`[HIERARCHY] Casino Commission (5%): ${commissionAmount.toFixed(2)}`);
        }

        let distributedSoFar = 0;

        for (let i = 0; i < chain.length; i++) {
            const user = chain[i];
            const isTopLevel = (i === chain.length - 1);

            // Direct Downline Name for the Final Sheet labeling
            const downlineName = (i === 0) ? username : chain[i - 1].username;

            // Net share calculation for hierarchical chain:
            // Master gets master.share
            // SuperMaster gets max(0, supermaster.share - master.share)
            // Admin gets max(0, admin.share - max(supermaster.share, master.share))
            // SuperAdmin gets max(0, 85 - highest downline share)
            let sharePercent;
            if (isTopLevel) {
                const maxDownlineShare = (i > 0) ? (chain[i - 1].share || 0) : 0;
                sharePercent = SUPERADMIN_TOTAL_PERCENT - maxDownlineShare;
                if (sharePercent < 0) sharePercent = 0;
            } else {
                const userShare = user.share || 0;
                const prevShare = (i > 0) ? (chain[i - 1].share || 0) : 0;
                sharePercent = Math.max(0, userShare - prevShare);
            }

            let earnings = (sharePercent / 100) * amount;

            // Deduct casino commission from SuperAdmin's portion
            if (isTopLevel && commissionAmount > 0) {
                console.log(`[HIERARCHY] Deducting commission from SuperAdmin ${user.username} (${earnings.toFixed(2)} -> ${(earnings - commissionAmount).toFixed(2)})`);
                earnings -= commissionAmount;

                await Transaction.create({
                    userId: user.username,
                    amount: commissionAmount,
                    type: 'PLATFORM_COMMISSION',
                    description: desc,
                    matchName: matchDetails?.matchName || (isCasino ? 'Casino Game' : 'Cricket Match'),
                    selection: matchDetails?.selection,
                    category: isCasino ? 'casino' : 'cricket',
                    bettor: username,
                    downline: downlineName,
                    performedBy: 'SYSTEM'
                });
            }

            if (earnings !== 0) {
                await User.findByIdAndUpdate(user._id, { $inc: { walletBalance: earnings } });

                await Transaction.create({
                    userId: user.username,
                    amount: earnings,
                    type: 'COMMISSION_SHARE',
                    description: desc,
                    matchName: matchDetails?.matchName || (isCasino ? 'Casino Game' : 'Cricket Match'),
                    selection: matchDetails?.selection,
                    category: isCasino ? 'casino' : 'cricket',
                    bettor: username,
                    downline: downlineName,
                    performedBy: 'SYSTEM'
                });

                console.log(`[HIERARCHY] Distributed ${earnings.toFixed(2)} to ${user.role} ${user.username} (${sharePercent}% direct share)`);
                distributedSoFar += earnings;
            }
        }

        console.log(`[HIERARCHY] Distribution complete for ${username}. Total Hierarchy: ${distributedSoFar.toFixed(2)}, Book: ${bookAmount.toFixed(2)}`);
    } catch (err) {
        console.error('[HIERARCHY ERROR] Failed to distribute P/L:', err);
    }
}

/**
 * distributeProfitLoss - Legacy wrapper for Cricket/General
 */
async function distributeProfitLoss(username, amount, matchDetails = null) {
    return distributePL(username, amount, false, matchDetails);
}

/**
 * distributeCasinoPL - Specific wrapper for Casino
 */
async function distributeCasinoPL(username, amount, matchDetails = null) {
    return distributePL(username, amount, true, matchDetails);
}

module.exports = { distributeProfitLoss, distributeCasinoPL };
