const User = require('../models/User');

/**
 * Generate a normalized Final Sheet data structure.
 * @param {Object} currentUser - The user who is viewing the report.
 * @param {Array} txs - The list of transactions to process.
 * @returns {Object} { viewer, greenEntries, redEntries, totalGreen, totalRed, netAmount, platformFee, masterInfo }
 */
async function generateFinalSheet(currentUser, txs) {
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

    const mPortion = Math.abs(bNet) * (mShare / 100);
    const aPortion = Math.abs(bNet) * (aShare / 100);
    const saPortion = Math.abs(bNet) * (saShare / 100);
    const bookPortion = Math.abs(bNet) * (bookShare / 100);

    const parentPortion = Math.abs(bNet) - mPortion;
    const adminParentPortion = parentPortion - aPortion;

    if (currentUser.role === 'master') {
      if (bNet > 0) { // Bettor loses, Hierarchy Profit = Green
        addEntry('red', bName, bName, bNet, 'user');
        if (mPortion > 0) addEntry('green', currentUser.username, currentUser.username, mPortion, 'master');
        if (parentPortion > 0) addEntry('green', parentName, parentName, parentPortion, 'admin');
        netAmount += mPortion; 
      } else { // Bettor wins, Hierarchy Loss = Red
        addEntry('green', bName, bName, Math.abs(bNet), 'user');
        if (mPortion > 0) addEntry('red', currentUser.username, currentUser.username, mPortion, 'master');
        if (parentPortion > 0) addEntry('red', parentName, parentName, parentPortion, 'admin');
        netAmount -= mPortion;
      }
    } else if (currentUser.role === 'admin') {
      const downlineName = mUser ? mUser.username : 'Unknown Master';
      if (bNet > 0) { // Bettor loses, Hierarchy Profit = Green
        if (mPortion > 0) addEntry('green', downlineName, downlineName, mPortion, 'master');
        if (aPortion > 0) addEntry('green', currentUser.username, currentUser.username, aPortion, 'admin');
        if (adminParentPortion > 0) addEntry('green', parentName, parentName, adminParentPortion, 'superadmin');
        netAmount += aPortion;
      } else { // Bettor wins, Hierarchy Loss = Red
        if (mPortion > 0) addEntry('red', downlineName, downlineName, mPortion, 'master');
        if (aPortion > 0) addEntry('red', currentUser.username, currentUser.username, aPortion, 'admin');
        if (adminParentPortion > 0) addEntry('red', parentName, parentName, adminParentPortion, 'superadmin');
        netAmount -= aPortion;
      }
    } else if (currentUser.role === 'superadmin') {
      const downlineName = aUser ? aUser.username : 'Unknown Admin';
      if (bNet > 0) { // Bettor loses, Hierarchy Profit = Green
        if (parentPortion > 0) addEntry('green', downlineName, downlineName, parentPortion, 'admin');
        if (saPortion > 0) addEntry('green', currentUser.username, currentUser.username, saPortion, 'superadmin');
        if (bookPortion > 0) addEntry('green', 'BOOK', 'BOOK', bookPortion, 'book');
        netAmount += saPortion;
      } else { // Bettor wins, Hierarchy Loss = Red
        if (parentPortion > 0) addEntry('red', downlineName, downlineName, parentPortion, 'admin');
        if (saPortion > 0) addEntry('red', currentUser.username, currentUser.username, saPortion, 'superadmin');
        if (bookPortion > 0) addEntry('red', 'BOOK', 'BOOK', bookPortion, 'book');
        netAmount -= saPortion;
      }
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
