const User = require('../models/User');

/**
 * Generate a normalized Final Sheet or Daily Report data structure.
 * @param {Object} currentUser - The user who is viewing the report.
 * @param {Array} txs - The list of transactions to process.
 * @param {Boolean} isDailyReport - Whether this is for Daily Report (P/L only) or Final Sheet (cumulative with cash).
 * @returns {Object} { viewer, greenEntries, redEntries, totalGreen, totalRed, netAmount, platformFee, masterInfo }
 */
async function generateFinalSheet(currentUser, txs, isDailyReport = false) {
  const PLATFORM_FEE_RATE = 0.05;

  const uniqueBettorNames = [...new Set(txs.map(tx => tx.bettor).filter(Boolean))];
  const uniqueUsernamesFromTxs = [...new Set(txs.map(tx => tx.downline || tx.bettor).filter(Boolean))];
  const allUsernamesToLoad = [...new Set([...uniqueBettorNames, ...uniqueUsernamesFromTxs, currentUser.username])];

  const uniqueUsersInDb = await User.find({ username: { $in: allUsernamesToLoad } }).lean();

  let allUsersInDb = [];
  if (currentUser.role === 'superadmin') {
    allUsersInDb = await User.find({ role: { $ne: 'superadmin' } }).lean();
  } else {
    let parentsToFetch = [currentUser._id];
    while (parentsToFetch.length > 0) {
      const children = await User.find({ parentId: { $in: parentsToFetch } }).lean();
      if (!children || children.length === 0) break;
      allUsersInDb.push(...children);
      parentsToFetch = children.map(c => c._id);
    }
  }

  const userMap = {};
  [...uniqueUsersInDb, currentUser, ...allUsersInDb].forEach(u => {
    if (u) {
      userMap[u.username] = u;
      userMap[u._id.toString()] = u;
    }
  });

  // Recursively fetch any missing ancestor parents up the hierarchy chain
  let missingParentIds = Object.values(userMap)
    .map(u => u?.parentId)
    .filter(pid => pid && !userMap[pid.toString()]);

  while (missingParentIds.length > 0) {
    const fetchedAncestors = await User.find({ _id: { $in: missingParentIds } }).lean();
    missingParentIds = [];
    fetchedAncestors.forEach(a => {
      if (a) {
        userMap[a.username] = a;
        userMap[a._id.toString()] = a;
        if (a.parentId && !userMap[a.parentId.toString()]) {
          missingParentIds.push(a.parentId);
        }
      }
    });
  }

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

  function getRollupAccountForViewer(targetUsername, currentUser, userMap) {
    if (!targetUsername || targetUsername === 'cash' || targetUsername === 'BOOK') {
      return targetUsername;
    }
    const u = userMap[targetUsername];
    if (!u) return targetUsername;
    if (u.username === currentUser.username) return targetUsername;

    if (currentUser.role === 'superadmin') {
      let temp = u;
      let adminAccount = null;
      let childOfSuperAdmin = null;

      while (temp) {
        if (temp.role === 'admin') {
          adminAccount = temp;
        }
        if (temp.parentId && userMap[temp.parentId.toString()]) {
          const parent = userMap[temp.parentId.toString()];
          if (parent.role === 'superadmin' || parent.username === currentUser.username) {
            childOfSuperAdmin = temp;
          }
          temp = parent;
        } else {
          break;
        }
      }
      if (adminAccount) return adminAccount.username;
      if (childOfSuperAdmin) return childOfSuperAdmin.username;
      return targetUsername;
    }

    let curr = u;
    let childOfViewer = null;
    while (curr) {
      if (!curr.parentId) break;
      const parent = userMap[curr.parentId.toString()];
      if (!parent) break;

      if (parent.username === currentUser.username || parent._id.toString() === currentUser._id.toString()) {
        childOfViewer = curr;
        break;
      }
      curr = parent;
    }

    if (childOfViewer) {
      return childOfViewer.username;
    }

    return targetUsername;
  }

  txs.forEach(tx => {
    if (!isDailyReport) {
      if (tx.type === 'SETTLEMENT') {
        if (tx.userId === currentUser.username) {
          let rawSourceName = tx.downline;
          if (!rawSourceName || rawSourceName === currentUser.username) {
            rawSourceName = tx.performedBy;
          }
          if (!rawSourceName || rawSourceName === currentUser.username) return;

          const sourceName = getRollupAccountForViewer(rawSourceName, currentUser, userMap);
          if (sourceName === currentUser.username) return;

          const txAmount = tx.amount;
          if (!settlementSummary[sourceName]) {
            settlementSummary[sourceName] = { green: 0, red: 0 };
          }
          if (txAmount > 0) {
            settlementSummary[sourceName].green += txAmount;
          } else if (txAmount < 0) {
            settlementSummary[sourceName].red += Math.abs(txAmount);
          }
        }
        return;
      }
      // Cash Deposit / Withdrawal processing
      if (tx.type === 'CASH_WITHDRAWAL' && tx.userId === currentUser.username) {
        let rawSourceName = tx.downline || tx.performedBy;
        if (rawSourceName && rawSourceName !== currentUser.username) {
          const sourceName = getRollupAccountForViewer(rawSourceName, currentUser, userMap);
          if (sourceName !== currentUser.username) {
            if (!settlementSummary[sourceName]) settlementSummary[sourceName] = { green: 0, red: 0 };
            settlementSummary[sourceName].green += Math.abs(tx.amount);
          }
        }
        return;
      }

      if (tx.type === 'CASH_DEPOSIT' && tx.userId === currentUser.username) {
        let rawSourceName = tx.downline || tx.performedBy;
        if (rawSourceName && rawSourceName !== currentUser.username) {
          const sourceName = getRollupAccountForViewer(rawSourceName, currentUser, userMap);
          if (sourceName !== currentUser.username) {
            if (!settlementSummary[sourceName]) settlementSummary[sourceName] = { green: 0, red: 0 };
            settlementSummary[sourceName].red += Math.abs(tx.amount);
          }
        }
        return;
      }

      if (tx.userId === currentUser.username) {
        if (tx.type === 'WITHDRAW') {
          const parentUser = currentUser.parentId ? userMap[currentUser.parentId.toString()] : null;
          const parentName = parentUser ? parentUser.username : null;
          if (parentName) {
            if (!settlementSummary[parentName]) settlementSummary[parentName] = { green: 0, red: 0 };
            settlementSummary[parentName].red += Math.abs(tx.amount);
          }
          return;
        }
        if (tx.type === 'LOAD_BALANCE') {
          const parentUser = currentUser.parentId ? userMap[currentUser.parentId.toString()] : null;
          const parentName = parentUser ? parentUser.username : null;
          if (parentName) {
            if (!settlementSummary[parentName]) settlementSummary[parentName] = { green: 0, red: 0 };
            settlementSummary[parentName].green += Math.abs(tx.amount);
          }
          return;
        }
      }
    } else {
      // Daily Report mode: Skip all non-betting cash/balance/credit transactions
      const nonBettingTypes = ['SETTLEMENT', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'LOAD_BALANCE', 'WITHDRAW', 'LOAD_CREDIT', 'WITHDRAW_CREDIT', 'CREDIT_GIVEN', 'CREDIT_TAKEN'];
      if (nonBettingTypes.includes(tx.type)) {
        return;
      }
    }

    const bettorName = tx.bettor;
    const bettorUser = userMap[bettorName];
    if (!bettorUser) return;

    // Anchor bettor net calculation to the direct parent's COMMISSION_SHARE transaction (where downline === bettor)
    if (tx.type !== 'COMMISSION_SHARE' || tx.downline !== bettorName) {
      return;
    }

    const parentUser = userMap[tx.userId];
    let parentShare = parentUser ? (parentUser.share || 0) : 0;
    if (parentShare <= 0) {
      parentShare = (parentUser && parentUser.role === 'superadmin') ? 85 : 85;
    }

    const bettorNetForTx = - (tx.amount / (parentShare / 100));
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
  });

  const greenEntries = [];
  const redEntries = [];
  let totalGreen = 0;
  let totalRed = 0;
  let netAmount = 0;
  let totalPlatformFee = 0;

  function addEntry(side, accountId, accountName, amount, role, details = {}) {
    if (amount === 0) return;

    let targetName = accountName;
    let targetRole = role;

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
    let mUser = null, smUser = null, aUser = null;
    let temp = bUser;
    while (temp && temp.parentId) {
      let p = userMap[temp.parentId.toString()];
      if (!p) break;
      if (p.role === 'master') mUser = p;
      else if (p.role === 'supermaster') smUser = p;
      else if (p.role === 'admin') aUser = p;
      temp = p;
    }

    const mShare = mUser ? (mUser.share || 0) : 0;
    const smShare = smUser ? (smUser.share || 0) : 0;
    const aShare = aUser ? (aUser.share || 0) : 0;

    // Cumulative share limits up the hierarchy chain
    const mCum = mUser ? mShare : 0;
    const smCum = smUser ? Math.max(smShare, mCum) : mCum;
    const aCum = aUser ? Math.max(aShare, smCum) : smCum;

    // Net percentage for each role
    const mNetShare = mUser ? mCum : 0;
    const smNetShare = smUser ? Math.max(0, smCum - mCum) : 0;
    const aNetShare = aUser ? Math.max(0, aCum - smCum) : 0;

    let saNetShare = 0;
    let bookNetShare = 0;

    if (!isDailyReport) {
      // Final Sheet: SuperAdmin gets 85 - aCum, BOOK gets 15
      saNetShare = Math.max(0, 85 - aCum);
      bookNetShare = 15;
    } else {
      // Daily Report: BOOK is removed (0%), SuperAdmin gets 100 - aCum so accounts total 100%
      saNetShare = Math.max(0, 100 - aCum);
      bookNetShare = 0;
    }

    const mPortion    = Math.abs(bNet) * (mNetShare / 100);
    const smPortion   = Math.abs(bNet) * (smNetShare / 100);
    const aPortion    = Math.abs(bNet) * (aNetShare / 100);
    const saPortion   = Math.abs(bNet) * (saNetShare / 100);
    const bookPortion = Math.abs(bNet) * (bookNetShare / 100);

    const bettorSide = bNet > 0 ? 'green' : 'red';
    const otherSide = bNet > 0 ? 'red' : 'green';
    const amountAbs = Math.abs(bNet);

    if (currentUser.role === 'master') {
      const parentPortion = Math.abs(bNet) - mPortion;
      addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
      if (mPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, mPortion, 'master');
      if (parentPortion > 0) addEntry(otherSide, parentName, parentName, parentPortion, parentRole);
      
      netAmount += bNet > 0 ? -mPortion : mPortion;
      
    } else if (currentUser.role === 'supermaster') {
      const upstreamPortion = aPortion + saPortion + bookPortion;
      if (!isDailyReport) {
        if (mUser && mUser.username !== currentUser.username) {
          const masterObligation = smPortion + upstreamPortion;
          addEntry(bettorSide, mUser.username, mUser.username, masterObligation, 'master');
          if (smPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, smPortion, 'supermaster');
          if (upstreamPortion > 0) addEntry(otherSide, parentName, parentName, upstreamPortion, parentRole);
        } else {
          addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
          if (smPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, smPortion, 'supermaster');
          if (upstreamPortion > 0) addEntry(otherSide, parentName, parentName, upstreamPortion, parentRole);
        }
      } else {
        addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
        const masterName = mUser ? mUser.username : 'Unknown Master';
        if (mPortion > 0) addEntry(otherSide, masterName, masterName, mPortion, 'master');
        if (smPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, smPortion, 'supermaster');
        if (upstreamPortion > 0) addEntry(otherSide, parentName, parentName, upstreamPortion, parentRole);
      }

      netAmount += bNet > 0 ? -smPortion : smPortion;

    } else if (currentUser.role === 'admin') {
      const adminParentPortion = saPortion + bookPortion;
      if (!isDailyReport) {
        if (smUser && smUser.username !== currentUser.username) {
          const downlineObligation = aPortion + adminParentPortion;
          addEntry(bettorSide, smUser.username, smUser.username, downlineObligation, 'supermaster');
          if (aPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, aPortion, 'admin');
          if (adminParentPortion > 0) addEntry(otherSide, parentName, parentName, adminParentPortion, 'superadmin');
        } else if (mUser && mUser.username !== currentUser.username) {
          const masterObligation = aPortion + adminParentPortion;
          addEntry(bettorSide, mUser.username, mUser.username, masterObligation, 'master');
          if (aPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, aPortion, 'admin');
          if (adminParentPortion > 0) addEntry(otherSide, parentName, parentName, adminParentPortion, 'superadmin');
        } else {
          if (aPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, aPortion, 'admin');
          if (adminParentPortion > 0) addEntry(otherSide, parentName, parentName, adminParentPortion, 'superadmin');
        }
      } else {
        addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
        const masterName = mUser ? mUser.username : 'Unknown Master';
        const superMasterName = smUser ? smUser.username : null;
        if (mPortion > 0) addEntry(otherSide, masterName, masterName, mPortion, 'master');
        if (smPortion > 0 && superMasterName) addEntry(otherSide, superMasterName, superMasterName, smPortion, 'supermaster');
        if (aPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, aPortion, 'admin');
        if (adminParentPortion > 0) addEntry(otherSide, parentName, parentName, adminParentPortion, 'superadmin');
      }
      
      netAmount += bNet > 0 ? -aPortion : aPortion;
      
    } else if (currentUser.role === 'superadmin') {
      const masterName = mUser ? mUser.username : 'Unknown Master';
      const superMasterName = smUser ? smUser.username : null;
      const adminName = aUser ? aUser.username : 'Unknown Admin';

      if (!isDailyReport) {
        if (aUser && aUser.username !== currentUser.username) {
          const upstreamObligation = saPortion + bookPortion;
          addEntry(bettorSide, aUser.username, aUser.username, upstreamObligation, 'admin');
          if (saPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, saPortion, 'superadmin');
          if (bookPortion > 0) addEntry(otherSide, 'BOOK', 'BOOK', bookPortion, 'book');
        } else if (smUser && smUser.username !== currentUser.username) {
          const upstreamObligation = saPortion + bookPortion;
          addEntry(bettorSide, smUser.username, smUser.username, upstreamObligation, 'supermaster');
          if (saPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, saPortion, 'superadmin');
          if (bookPortion > 0) addEntry(otherSide, 'BOOK', 'BOOK', bookPortion, 'book');
        } else if (mUser && mUser.username !== currentUser.username) {
          const upstreamObligation = saPortion + bookPortion;
          addEntry(bettorSide, mUser.username, mUser.username, upstreamObligation, 'master');
          if (saPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, saPortion, 'superadmin');
          if (bookPortion > 0) addEntry(otherSide, 'BOOK', 'BOOK', bookPortion, 'book');
        } else {
          if (saPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, saPortion, 'superadmin');
          if (bookPortion > 0) addEntry(otherSide, 'BOOK', 'BOOK', bookPortion, 'book');
        }
      } else {
        addEntry(bettorSide, bName, bName, amountAbs, 'user', { breakdown: bBreakdown });
        if (mPortion > 0) addEntry(otherSide, masterName, masterName, mPortion, 'master');
        if (smPortion > 0 && superMasterName) addEntry(otherSide, superMasterName, superMasterName, smPortion, 'supermaster');
        if (aPortion > 0) addEntry(otherSide, adminName, adminName, aPortion, 'admin');
        if (saPortion > 0) addEntry(otherSide, currentUser.username, currentUser.username, saPortion, 'superadmin');
      }
      
      netAmount += bNet > 0 ? -saPortion : saPortion;
    }
  }

  // Handle explicit manual settlements ONLY for Final Sheet (not Daily Report)
  if (!isDailyReport) {
    for (const [name, setl] of Object.entries(settlementSummary)) {
      const netSetl = setl.green - setl.red;
      if (netSetl === 0) continue;
      const role = roleMap[name] || 'user';
      const isParent = (currentUser.parentId && userMap[currentUser.parentId.toString()]?.username === name);

      if (isParent) {
        netAmount += netSetl;
        // Viewer is Child, name is Parent:
        if (netSetl > 0) {
          // Child received cash deposit / parent debited: Parent on Green side
          addEntry('green', name, name, netSetl, role);
          addEntry('red', 'cash', 'cash', netSetl, 'cash');
        } else {
          // Child paid cash withdrawal / parent credited: Parent on Red side
          addEntry('red', name, name, Math.abs(netSetl), role);
          addEntry('green', 'cash', 'cash', Math.abs(netSetl), 'cash');
        }
      } else {
        // Viewer is Parent/Admin, name is Child/Downline:
        if (netSetl > 0) {
          // Cash withdrawal from downline / settlement of green balance: Child on Red side (deducts P/L)
          addEntry('red', name, name, netSetl, role);
          addEntry('green', 'cash', 'cash', netSetl, 'cash');
        } else {
          // Cash deposit to downline / settlement of red balance: Child on Green side (adds P/L)
          addEntry('green', name, name, Math.abs(netSetl), role);
          addEntry('red', 'cash', 'cash', Math.abs(netSetl), 'cash');
        }
      }
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
  if (!isDailyReport) {
    allUsersInDb.forEach(u => {
      const isDirectChild = u && u.parentId && u.parentId.toString() === currentUser._id.toString();
      if (isDirectChild && u.username && u.username !== currentUser.username && u.username !== 'cash' && u.username !== 'BOOK') {
        allAccountIds.add(u.username);
      }
    });
  }

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
      const baseEntry = greenEntry || redEntry;
      finalGreen.push({ ...baseEntry, amount: roundedDiff });
      calculatedTotalGreen += roundedDiff;
    } else if (roundedDiff < 0) {
      const baseEntry = redEntry || greenEntry;
      finalRed.push({ ...baseEntry, amount: Math.abs(roundedDiff) });
      calculatedTotalRed += Math.abs(roundedDiff);
    } else {
      if (!isDailyReport) {
        const baseEntry = greenEntry || redEntry;
        if (baseEntry && baseEntry.accountId !== 'cash' && baseEntry.accountId !== 'BOOK') {
          finalGreen.push({ ...baseEntry, amount: 0 });
        } else if (id !== 'cash' && id !== 'BOOK' && id !== currentUser.username) {
          const uDoc = userMap[id];
          const uRole = uDoc ? uDoc.role : 'user';
          let parentName = null;
          if (uDoc && uDoc.parentId) {
            const pDoc = userMap[uDoc.parentId.toString()];
            if (pDoc) parentName = pDoc.username;
          }
          finalGreen.push({
            accountId: id,
            accountName: id,
            amount: 0,
            role: uRole,
            parentName
          });
        }
      }
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
