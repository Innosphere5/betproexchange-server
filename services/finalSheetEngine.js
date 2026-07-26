const User = require('../models/User');

/**
 * Generate a normalized Final Sheet data structure.
 * @param {Object} currentUser - The user who is viewing the report.
 * @param {Array} txs - The list of transactions to process.
 * @returns {Object} { viewer, greenEntries, redEntries, totalGreen, totalRed, netAmount, platformFee, masterInfo }
 */
async function generateFinalSheet(currentUser, txs, isDailyReport = false) {
  const PLATFORM_FEE_RATE = 0.05;

  const uniqueBettorNames = [...new Set(txs.map(tx => tx.bettor).filter(Boolean))];
  const uniqueUsernamesFromTxs = [...new Set(txs.map(tx => tx.downline || tx.bettor).filter(Boolean))];
  const allUsernamesToLoad = [...new Set([...uniqueBettorNames, ...uniqueUsernamesFromTxs, currentUser.username])];

  const uniqueUsersInDb = await User.find({ username: { $in: allUsernamesToLoad } }).lean();
  const parentIds = uniqueUsersInDb.map(u => u.parentId).filter(Boolean);
  const parents = await User.find({ _id: { $in: parentIds } }).lean();
  const grandParentIds = parents.map(p => p.parentId).filter(Boolean);
  const grandParents = await User.find({ _id: { $in: grandParentIds } }).lean();

  let allUsersInDb = [];
  if (currentUser.role === 'superadmin') {
    allUsersInDb = await User.find({ role: { $ne: 'superadmin' } }).lean();
  } else if (currentUser.role === 'admin') {
    const adminDownlines = await User.find({ parentId: currentUser._id }).lean();
    const masterIds = adminDownlines.filter(u => u.role === 'master').map(u => u._id);
    const masterBettors = await User.find({ role: 'user', parentId: { $in: masterIds } }).lean();
    allUsersInDb = [...adminDownlines, ...masterBettors];
  } else if (currentUser.role === 'master') {
    allUsersInDb = await User.find({ parentId: currentUser._id }).lean();
  }


  const userMap = {};
  [...uniqueUsersInDb, ...parents, ...grandParents, currentUser, ...allUsersInDb].forEach(u => {
    if (u) {
      userMap[u.username] = u;
      userMap[u._id.toString()] = u;
    }
  });

  const roleMap = {};
  Object.values(userMap).forEach(u => {
    roleMap[u.username] = u.role;
  });

  let parentName = 'Admin';
  let parentShare = 0;
  let grandParentName = 'SuperAdmin';
  let grandParentShare = 0;

  let parentRole = 'admin';

  if (currentUser.parentId) {
    const parentUser = userMap[currentUser.parentId.toString()];
    if (parentUser) {
      parentName = parentUser.username;
      parentShare = parentUser.share || 0;
      parentRole = parentUser.role;
      if (parentUser.parentId) {
        const grandParent = userMap[parentUser.parentId.toString()];
        if (grandParent) {
          grandParentName = grandParent.username;
          grandParentShare = grandParent.share || 0;
        }
      }
    }
  }

  const masterShare = currentUser.share || 0;
  const superAdminEffectiveShare = Math.max(0, 85 - parentShare - masterShare);
  const bookShare = 15;

  let masterInfo = {
    masterName: currentUser.username,
    masterShare,
    parentName,
    parentShare,
    grandParentName,
    grandParentShare,
    superAdminEffectiveShare,
    role: currentUser.role,
    platformFeeRate: PLATFORM_FEE_RATE,
    bookShare
  };

  if (currentUser.role === 'admin') {
    masterInfo.upstreamShare = superAdminEffectiveShare + bookShare;
  } else if (currentUser.role === 'superadmin') {
    masterInfo.upstreamShare = bookShare;
    masterInfo.parentName = 'BOOK';
  }

  const bettorSummary = {};
  const settlementSummary = {};

  txs.forEach(tx => {
    if (!tx.bettor || tx.type === 'SETTLEMENT') {
      let sourceName = tx.downline || tx.bettor || 'Unknown';
      let txAmount = tx.amount;

      // Handle parent settlements (where current user is the downline)
      if (tx.downline === currentUser.username) {
        sourceName = parentName;
        txAmount = -tx.amount; // invert sign to match current user's perspective
      }

      if (sourceName === currentUser.username) {
        return; // Skip self transactions
      }

      if (!settlementSummary[sourceName]) {
        settlementSummary[sourceName] = { green: 0, red: 0 };
      }
      if (txAmount > 0) {
        settlementSummary[sourceName].red += txAmount;
      } else if (txAmount < 0) {
        settlementSummary[sourceName].green += Math.abs(txAmount);
      }
      return;
    }

    const bettorName = tx.bettor;
    const bettorUser = userMap[bettorName];
    if (!bettorUser) return;

    let mUser = null, aUser = null;
    let temp = bettorUser;
    while (temp && temp.parentId) {
      let p = userMap[temp.parentId.toString()];
      if (!p) break;
      if (p.role === 'master') mUser = p;
      else if (p.role === 'admin') aUser = p;
      temp = p;
    }

    const mShare = mUser ? (mUser.share || 0) : 0;
    const aShare = aUser ? (aUser.share || 0) : 0;
    const saShare = Math.max(0, 85 - aShare - mShare);

    if (currentUser.role === 'superadmin' && saShare > 0 && tx.type === 'BOOK_SHARE') {
      return;
    }

    let sharePercent = 0;
    if (currentUser.role === 'master') sharePercent = mShare;
    else if (currentUser.role === 'admin') sharePercent = aShare;
    else if (currentUser.role === 'superadmin') {
      if (tx.type === 'BOOK_SHARE') sharePercent = 15;
      else sharePercent = saShare;
    }

    if (sharePercent > 0) {
      const bettorNetForTx = - (tx.amount / (sharePercent / 100));
      if (!bettorSummary[bettorName]) {
        bettorSummary[bettorName] = { 
          total: 0, 
          breakdown: { 
            cricket: { wins: 0, losses: 0, net: 0 }, 
            casino: { wins: 0, losses: 0, net: 0 },
            totalNet: 0
          } 
        };
      }
      bettorSummary[bettorName].total += bettorNetForTx;
      
      const category = tx.category === 'casino' ? 'casino' : 'cricket';
      bettorSummary[bettorName].breakdown[category].net += bettorNetForTx;
      if (bettorNetForTx > 0) {
        bettorSummary[bettorName].breakdown[category].wins += bettorNetForTx;
      } else {
        bettorSummary[bettorName].breakdown[category].losses += Math.abs(bettorNetForTx);
      }
      bettorSummary[bettorName].breakdown.totalNet += bettorNetForTx;
    }
  });

  const greenEntries = [];
  const redEntries = [];
  let totalGreen = 0;
  let totalRed = 0;
  let netAmount = 0;
  let totalPlatformFee = 0;

  function getRollupTarget(accountName, accountRole) {
    return { name: accountName, role: accountRole };
  }


  function addEntry(side, accountId, accountName, amount, role, details = {}) {
    if (amount === 0) return;

    let targetName = accountName;
    let targetRole = role;

    if (!isDailyReport && currentUser.role !== 'master') {
      const target = getRollupTarget(accountName, role);
      targetName = target.name;
      targetRole = target.role;
    }

    // Auto-populate parentName if role is user (bettor)
    if (targetRole === 'user' && !details.parentName) {
      const uDoc = userMap[targetName];
      if (uDoc && uDoc.parentId) {
        const pDoc = userMap[uDoc.parentId.toString()];
        if (pDoc) {
          details.parentName = pDoc.username;
        }
      }
    }

    const entry = { accountId: targetName, accountName: targetName, amount, role: targetRole, ...details };
    if (side === 'green') {
      greenEntries.push(entry);
      totalGreen += amount;
    } else {
      redEntries.push(entry);
      totalRed += amount;
    }
  }

  for (const [bName, bData] of Object.entries(bettorSummary)) {
    const bNet = bData.total;
    const bBreakdown = bData.breakdown;
    if (bNet === 0) continue;
    
    const bUser = userMap[bName];
    if (!bUser) continue;
    let mUser = null, aUser = null;
    let temp = bUser;
    while (temp && temp.parentId) {
      let p = userMap[temp.parentId.toString()];
      if (!p) break;
      if (p.role === 'master') mUser = p;
      else if (p.role === 'admin') aUser = p;
      temp = p;
    }

    const mShare = mUser ? (mUser.share || 0) : 0;
    const aShare = aUser ? (aUser.share || 0) : 0;
    const saShare = Math.max(0, 85 - aShare - mShare);

    // Compute share portions — identical for both daily report and final sheet.
    // 85% is split: Master gets mShare%, Admin gets aShare%, SuperAdmin gets (85 - aShare - mShare)%.
    // 15% always goes to Book (platform).
    const mPortion    = Math.abs(bNet) * (mShare / 100);
    const aPortion    = Math.abs(bNet) * (Math.max(0, aShare - mShare) / 100);
    const saPortion   = Math.abs(bNet) * (Math.max(0, 85 - aShare) / 100);
    const bookPortion = Math.abs(bNet) * (bookShare / 100); // always 15%

    const parentPortion = Math.abs(bNet) - mPortion;
    const adminParentPortion = parentPortion - aPortion;

    // Determine sides based on who won:
    // bNet > 0 means the bettor won. Bettor goes to Green, hierarchy goes to Red.
    // bNet < 0 means the bettor lost. Bettor goes to Red, hierarchy goes to Green.
    const bettorSide = bNet > 0 ? 'green' : 'red';
    const otherSide = bNet > 0 ? 'red' : 'green';
    const amountAbs = Math.abs(bNet);

    if (currentUser.role === 'master') {
      // Green side: Bettor (when bettor wins) / Red side: Bettor (when bettor loses)
      addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
      
      // Other side: Master and Admin (parent)
      if (mPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, mPortion, 'master');
      if (parentPortion > 0) addEntry(otherSide, parentName, parentName, parentPortion, 'admin');
      
      netAmount += bNet > 0 ? -mPortion : mPortion;
      
    } else if (currentUser.role === 'admin') {
      // Green side: Bettor (when bettor wins) / Red side: Bettor (when bettor loses)
      addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
      
      // Other side: Master, Admin, and SuperAdmin (parent)
      const masterName = mUser ? mUser.username : 'Unknown Master';
      if (mPortion > 0) addEntry(otherSide, masterName, masterName, mPortion, 'master');
      if (aPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, aPortion, 'admin');
      if (adminParentPortion > 0) addEntry(otherSide, parentName, parentName, adminParentPortion, 'superadmin');
      
      netAmount += bNet > 0 ? -aPortion : aPortion;
      
    } else if (currentUser.role === 'superadmin') {
      // Green side: Bettor (when bettor wins) / Red side: Bettor (when bettor loses)
      addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
      
      // Other side: Master, Admin, SuperAdmin, and Book
      const masterName = mUser ? mUser.username : 'Unknown Master';
      const adminName = aUser ? aUser.username : 'Unknown Admin';
      
      if (mPortion > 0) addEntry(otherSide, masterName, masterName, mPortion, 'master');
      if (aPortion > 0) addEntry(otherSide, adminName, adminName, aPortion, 'admin');
      if (saPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, saPortion, 'superadmin');
      if (bookPortion > 0) addEntry(otherSide, 'BOOK', 'BOOK', bookPortion, 'book');
      
      netAmount += bNet > 0 ? -saPortion : saPortion;
    }
  }

  // Handle explicit manual settlements
  for (const [name, setl] of Object.entries(settlementSummary)) {
    const netSetl = setl.green - setl.red;
    if (netSetl === 0) continue;
    const role = roleMap[name] || 'user';
    
    if (netSetl > 0) {
      addEntry('green', name, name, netSetl, role);
      // Double-entry balancing: the viewer (currentUser) funded this settlement (outgoing/red)
      addEntry('red', currentUser.username, currentUser.username, netSetl, currentUser.role);
    } else {
      addEntry('red', name, name, Math.abs(netSetl), role);
      // Double-entry balancing: the viewer (currentUser) received this settlement (incoming/green)
      addEntry('green', currentUser.username, currentUser.username, Math.abs(netSetl), currentUser.role);
    }
  }

  // 1. Group and sum green and red amounts per accountId
  const greenTotalsMap = {};
  const redTotalsMap = {};

  for (const entry of greenEntries) {
    const id = entry.accountId;
    if (!greenTotalsMap[id]) {
      greenTotalsMap[id] = { ...entry, amount: 0 };
    }
    greenTotalsMap[id].amount += entry.amount;
  }

  for (const entry of redEntries) {
    const id = entry.accountId;
    if (!redTotalsMap[id]) {
      redTotalsMap[id] = { ...entry, amount: 0 };
    }
    redTotalsMap[id].amount += entry.amount;
  }

  // 2. Net the amounts for each unique accountId
  const allAccountIds = new Set([...Object.keys(greenTotalsMap), ...Object.keys(redTotalsMap)]);
  const finalGreen = [];
  const finalRed = [];
  let calculatedTotalGreen = 0;
  let calculatedTotalRed = 0;

  for (const id of allAccountIds) {
    const greenEntry = greenTotalsMap[id];
    const redEntry = redTotalsMap[id];

    const greenAmt = greenEntry ? greenEntry.amount : 0;
    const redAmt = redEntry ? redEntry.amount : 0;

    const diff = greenAmt - redAmt;
    const roundedDiff = Math.round(diff * 100) / 100;

    if (roundedDiff > 0) {
      // Net Green (Incoming)
      const baseEntry = greenEntry || redEntry;
      finalGreen.push({ ...baseEntry, amount: roundedDiff });
      calculatedTotalGreen += roundedDiff;
    } else if (roundedDiff < 0) {
      // Net Red (Outgoing)
      const baseEntry = redEntry || greenEntry;
      finalRed.push({ ...baseEntry, amount: Math.abs(roundedDiff) });
      calculatedTotalRed += Math.abs(roundedDiff);
    }
  }

  totalGreen = Math.round(calculatedTotalGreen * 100) / 100;
  totalRed = Math.round(calculatedTotalRed * 100) / 100;
  netAmount = Math.round(netAmount * 100) / 100;

  return {
    viewer: currentUser.role.toUpperCase(),
    greenEntries: finalGreen,
    redEntries: finalRed,
    totalGreen,
    totalRed,
    netAmount,
    platformFee: totalPlatformFee,
    masterInfo,
    allUsers: allUsersInDb.map(u => ({
      username: u.username,
      role: u.role,
      share: u.share || 0,
      parentId: u.parentId,
      parentName: u.parentId ? (userMap[u.parentId.toString()]?.username || null) : null
    }))
  };
}

module.exports = {
  generateFinalSheet
};
