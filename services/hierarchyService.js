const User = require('../models/User');
const Transaction = require('../models/Transaction');

/**
 * Distribute profit/loss up the hierarchy chain using Fixed Share logic.
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
            let mySharePercent = isTopLevel ? 100 : (user.share || 0);
            
            let shareDiff = mySharePercent - childShare;
            if (shareDiff < 0) shareDiff = 0;

            let earnings = (shareDiff / 100) * amount;

            // Direct Downline Name for the Final Sheet labeling
            // If i=0, the downline is the bettor. 
            // If i>0, the downline is the child user in the chain.
            const downlineName = (i === 0) ? username : chain[i - 1].username;

            if (isTopLevel && commissionAmount > 0) {
                console.log(`[HIERARCHY] Deducting commission from SuperAdmin ${user.username} (${earnings.toFixed(2)} -> ${(earnings - commissionAmount).toFixed(2)})`);
                earnings -= commissionAmount;
                
                let pDesc = isCasino ? 'Casino Game' : 'Cricket Match';
                if (matchDetails && matchDetails.matchName) {
                    pDesc = `${matchDetails.matchName}${matchDetails.selection ? ` (${matchDetails.selection})` : ''}`;
                }

                await Transaction.create({
                    userId: user.username,
                    amount: commissionAmount,
                    type: 'PLATFORM_COMMISSION',
                    description: pDesc,
                    matchName: matchDetails?.matchName || (isCasino ? 'Casino Game' : 'Cricket Match'),
                    selection: matchDetails?.selection,
                    category: isCasino ? 'casino' : 'cricket',
                    bettor: username,
                    performedBy: 'SYSTEM'
                });
            }

            if (earnings !== 0) {
                await User.findByIdAndUpdate(user._id, { $inc: { walletBalance: earnings } });
                
                let desc = isCasino ? 'Casino Game' : 'Cricket Match';
                if (matchDetails && matchDetails.matchName) {
                    desc = `${matchDetails.matchName}${matchDetails.selection ? ` (${matchDetails.selection})` : ''}`;
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
