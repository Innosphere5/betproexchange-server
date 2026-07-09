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

  const userMap = {};
  [...uniqueUsersInDb, ...parents, ...grandParents, currentUser].forEach(u => {
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

  if (currentUser.parentId) {
    const parentUser = userMap[currentUser.parentId.toString()];
    if (parentUser) {
      parentName = parentUser.username;
      parentShare = parentUser.share || 0;
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
      const sourceName = tx.downline || tx.bettor || 'Unknown';
      if (!settlementSummary[sourceName]) {
        settlementSummary[sourceName] = { green: 0, red: 0 };
      }
      if (tx.amount > 0) {
        settlementSummary[sourceName].red += tx.amount;
      } else if (tx.amount < 0) {
        settlementSummary[sourceName].green += Math.abs(tx.amount);
      }
      return;
    }

    const bettorName = tx.bettor;
    const bettorUser = userMap[bettorName];
    if (!bettorUser) return;

    const mUser = bettorUser.parentId ? userMap[bettorUser.parentId.toString()] : null;
    const aUser = mUser && mUser.parentId ? userMap[mUser.parentId.toString()] : null;

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
      if (!bettorSummary[bettorName]) bettorSummary[bettorName] = 0;
      bettorSummary[bettorName] += bettorNetForTx;
    }
  });

  const greenEntries = [];
  const redEntries = [];
  let totalGreen = 0;
  let totalRed = 0;
  let netAmount = 0;
  let totalPlatformFee = 0;

  function addEntry(side, accountId, accountName, amount, role, details = {}) {
    if (amount === 0) return;

    // Auto-populate parentName if role is user (bettor)
    if (role === 'user' && !details.parentName) {
      const uDoc = userMap[accountName];
      if (uDoc && uDoc.parentId) {
        const pDoc = userMap[uDoc.parentId.toString()];
        if (pDoc) {
          details.parentName = pDoc.username;
        }
      }
    }

    const entry = { accountId, accountName, amount, role, ...details };
    if (side === 'green') {
      greenEntries.push(entry);
      totalGreen += amount;
    } else {
      redEntries.push(entry);
      totalRed += amount;
    }
  }

  for (const [bName, bNet] of Object.entries(bettorSummary)) {
    if (bNet === 0) continue;
    
    const bUser = userMap[bName];
    if (!bUser) continue;
    const mUser = bUser.parentId ? userMap[bUser.parentId.toString()] : null;
    const aUser = mUser && mUser.parentId ? userMap[mUser.parentId.toString()] : null;

    const mShare = mUser ? (mUser.share || 0) : 0;
    const aShare = aUser ? (aUser.share || 0) : 0;
    const saShare = Math.max(0, 85 - aShare - mShare);

    let mPortion, aPortion, saPortion, bookPortion;
    if (isDailyReport) {
      mPortion = Math.abs(bNet) * (mShare / 100);
      aPortion = Math.abs(bNet) * (Math.max(0, aShare - mShare) / 100);
      saPortion = Math.abs(bNet) * (Math.max(0, 100 - aShare) / 100);
      bookPortion = 0;
    } else {
      mPortion = Math.abs(bNet) * (mShare / 100);
      aPortion = Math.abs(bNet) * (Math.max(0, aShare - mShare) / 100);
      saPortion = Math.abs(bNet) * (Math.max(0, 85 - aShare) / 100);
      bookPortion = Math.abs(bNet) * (bookShare / 100);
    }

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
      addEntry(bettorSide, bName, bName, amountAbs, 'user');
      
      // Other side: Master and Admin (parent)
      if (mPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, mPortion, 'master');
      if (parentPortion > 0) addEntry(otherSide, parentName, parentName, parentPortion, 'admin');
      
      netAmount += bNet > 0 ? -mPortion : mPortion;
      
    } else if (currentUser.role === 'admin') {
      // Green side: Bettor (when bettor wins) / Red side: Bettor (when bettor loses)
      addEntry(bettorSide, bName, bName, amountAbs, 'user');
      
      // Other side: Master, Admin, and SuperAdmin (parent)
      const masterName = mUser ? mUser.username : 'Unknown Master';
      if (mPortion > 0) addEntry(otherSide, masterName, masterName, mPortion, 'master');
      if (aPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, aPortion, 'admin');
      if (adminParentPortion > 0) addEntry(otherSide, parentName, parentName, adminParentPortion, 'superadmin');
      
      netAmount += bNet > 0 ? -aPortion : aPortion;
      
    } else if (currentUser.role === 'superadmin') {
      // Green side: Bettor (when bettor wins) / Red side: Bettor (when bettor loses)
      addEntry(bettorSide, bName, bName, amountAbs, 'user');
      
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
    } else {
      addEntry('red', name, name, Math.abs(netSetl), role);
    }
  }

  function aggregateEntries(entries) {
    const map = {};
    for (const entry of entries) {
      if (!map[entry.accountId]) map[entry.accountId] = { ...entry, amount: 0 };
      map[entry.accountId].amount += entry.amount;
    }
    return Object.values(map).map(e => ({ ...e, amount: Math.round(e.amount * 100) / 100 })).filter(e => e.amount > 0);
  }

  const finalGreen = aggregateEntries(greenEntries);
  const finalRed = aggregateEntries(redEntries);
  totalGreen = Math.round(totalGreen * 100) / 100;
  totalRed = Math.round(totalRed * 100) / 100;
  netAmount = Math.round(netAmount * 100) / 100;

  return {
    viewer: currentUser.role.toUpperCase(),
    greenEntries: finalGreen,
    redEntries: finalRed,
    totalGreen,
    totalRed,
    netAmount,
    platformFee: totalPlatformFee,
    masterInfo
  };
}

module.exports = {
  generateFinalSheet
};
