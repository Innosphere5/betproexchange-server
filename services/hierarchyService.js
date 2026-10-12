const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { findUserByKey } = require('./hierarchyHelper');

/**
 * DYNAMIC SHARE SPLIT (per SuperAdmin):
 *   SuperAdmin.share% → SuperAdmin hierarchy (SuperAdmin + Admin + SuperMaster + Master)
 *   (100 - SuperAdmin.share)% → Book (Platform)
 *
 * Platform Fee Logic:
 *   - 1.5% platform fee is deducted FIRST, ONLY ON PROFIT (amount > 0).
 *   - On loss (amount < 0), 0% commission is deducted.
 *   - The remaining profit (or full loss) is distributed among shareholders (Book + Hierarchy chain).
 */

const PLATFORM_FEE_RATE = 0.015; // 1.5% platform fee

/**
 * Distribute profit/loss up the hierarchy chain using Direct Share logic.
 * @param {string} username - The username of the bettor.
 * @param {number} amount - Total amount to distribute (House Profit +ve, House Loss -ve).
 * @param {boolean} isCasino - Whether this is a casino bet.
 * @param {object} matchDetails - { matchName, selection }
 * @param {object} io - Socket.io instance for live balance update notifications
 */
async function distributePL(username, amount, isCasino = false, matchDetails = null, io = null) {
    if (amount === 0) return;

    try {
        const bettor = await findUserByKey(username) || await User.findOne({ username });
        if (!bettor) {
            console.warn(`[HIERARCHY] Bettor ${username} not found. Distribution skipped.`);
            return;
        }

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

        // Dynamically determine Book Share and SuperAdmin Total from the top-level SuperAdmin
        const superAdmin = chain[chain.length - 1];
        const SUPERADMIN_TOTAL_PERCENT = superAdmin.share ?? 85;
        const BOOK_SHARE_PERCENT = Math.max(0, 100 - SUPERADMIN_TOTAL_PERCENT);

        let desc = isCasino ? 'Casino Game' : 'Cricket Match';
        if (matchDetails && matchDetails.matchName) {
            desc = `${matchDetails.matchName}${matchDetails.selection ? ` (${matchDetails.selection})` : ''}`;
        }

        // ──────────────────────────────────────────────
        // 1. 1.5% PLATFORM FEE (Deducted FIRST, only on PROFIT)
        // ──────────────────────────────────────────────
        let platformCommission = 0;
        let distributableAmount = amount;

        if (amount > 0) {
            // Deducted first then distributed on only profit
            platformCommission = Math.round(amount * PLATFORM_FEE_RATE * 100) / 100;
            distributableAmount = Math.round((amount - platformCommission) * 100) / 100;
            console.log(`[HIERARCHY] Platform Fee (1.5% on Profit of ${amount}): ${platformCommission.toFixed(2)}, Distributable: ${distributableAmount.toFixed(2)}`);

            await Transaction.create({
                userId: superAdmin.username,
                amount: platformCommission,
                type: 'PLATFORM_COMMISSION',
                description: `1.5% Platform Fee - ${desc}`,
                matchName: matchDetails?.matchName || (isCasino ? 'Casino Game' : 'Cricket Match'),
                selection: matchDetails?.selection,
                category: isCasino ? 'casino' : 'cricket',
                bettor: username,
                bettorNet: -amount,
                downline: 'PLATFORM',
                performedBy: 'SYSTEM'
            });
        }

        console.log(`[HIERARCHY] Starting ${isCasino ? 'CASINO' : 'CRICKET'} Distribution of ${distributableAmount.toFixed(2)} for ${username} (SuperAdmin: ${superAdmin.username}, HierarchyShare: ${SUPERADMIN_TOTAL_PERCENT}%, BookShare: ${BOOK_SHARE_PERCENT}%)`);

        // ──────────────────────────────────────────────
        // 2. BOOK SHARE (Dynamic % based on SuperAdmin)
        // ──────────────────────────────────────────────
        const bookAmount = Math.round((BOOK_SHARE_PERCENT / 100) * distributableAmount * 100) / 100;
        if (bookAmount !== 0 && BOOK_SHARE_PERCENT > 0) {
            await Transaction.create({
                userId: superAdmin.username,
                amount: bookAmount,
                type: 'BOOK_SHARE',
                description: desc,
                matchName: matchDetails?.matchName || (isCasino ? 'Casino Game' : 'Cricket Match'),
                selection: matchDetails?.selection,
                category: isCasino ? 'casino' : 'cricket',
                bettor: username,
                bettorNet: -amount,
                downline: 'BOOK',
                performedBy: 'SYSTEM'
            });

            console.log(`[HIERARCHY] Book Share (${BOOK_SHARE_PERCENT}%): ${bookAmount.toFixed(2)}`);
        }

        // ──────────────────────────────────────────────
        // 3. HIERARCHY DISTRIBUTION (SuperAdmin.share% split among chain)
        // ──────────────────────────────────────────────
        let distributedSoFar = 0;

        for (let i = 0; i < chain.length; i++) {
            const user = chain[i];
            const isTopLevel = (i === chain.length - 1);
            const isDirectParent = (i === 0);

            // Direct Downline Name for the Final Sheet labeling
            const downlineName = isDirectParent ? username : chain[i - 1].username;

            // Cumulative max downline share so far
            const maxDownlineShareSoFar = (i > 0) 
                ? chain.slice(0, i).reduce((max, u) => Math.max(max, u.share || 0), 0) 
                : 0;

            let sharePercent;
            if (isTopLevel) {
                sharePercent = Math.max(0, SUPERADMIN_TOTAL_PERCENT - maxDownlineShareSoFar);
            } else {
                const userShare = user.share || 0;
                sharePercent = Math.max(0, userShare - maxDownlineShareSoFar);
            }

            let earnings = Math.round((sharePercent / 100) * distributableAmount * 100) / 100;

            if (earnings !== 0 || isDirectParent) {
                let updatedUser = null;
                if (earnings !== 0) {
                    updatedUser = await User.findByIdAndUpdate(
                        user._id, 
                        { $inc: { walletBalance: earnings } },
                        { new: true }
                    );

                    if (io && updatedUser) {
                        io.emit('wallet_updated', { userId: updatedUser.username, balance: updatedUser.walletBalance });
                    }
                }

                await Transaction.create({
                    userId: user.username,
                    amount: earnings,
                    type: 'COMMISSION_SHARE',
                    description: desc,
                    matchName: matchDetails?.matchName || (isCasino ? 'Casino Game' : 'Cricket Match'),
                    selection: matchDetails?.selection,
                    category: isCasino ? 'casino' : 'cricket',
                    bettor: username,
                    bettorNet: -amount,
                    downline: downlineName,
                    performedBy: 'SYSTEM'
                });

                console.log(`[HIERARCHY] Distributed ${earnings.toFixed(2)} to ${user.role} ${user.username} (${sharePercent}% direct share)`);
                distributedSoFar += earnings;
            }
        }

        console.log(`[HIERARCHY] Distribution complete for ${username}. Total Hierarchy: ${distributedSoFar.toFixed(2)}, Book: ${bookAmount.toFixed(2)}, PlatformFee: ${platformCommission.toFixed(2)}`);
    } catch (err) {
        console.error('[HIERARCHY ERROR] Failed to distribute P/L:', err);
    }
}

/**
 * distributeProfitLoss - Wrapper for Cricket/General
 */
async function distributeProfitLoss(username, amount, matchDetails = null, io = null) {
    return distributePL(username, amount, false, matchDetails, io);
}

/**
 * distributeCasinoPL - Specific wrapper for Casino
 */
async function distributeCasinoPL(username, amount, matchDetails = null, io = null) {
    return distributePL(username, amount, true, matchDetails, io);
}

module.exports = { distributeProfitLoss, distributeCasinoPL, PLATFORM_FEE_RATE };
