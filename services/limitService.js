const User = require('../models/User');
const UserProfitLimit = require('../models/UserProfitLimit');
const hierarchyHelper = require('./hierarchyHelper');

const DEFAULT_MAX_BET_SIZES = {
  cricket: 5000000,
  soccer: 1000000,
  tennis: 250000,
  fancy: 2000000,
  bookmaker: 2000000,
  races: 200000,
  greyhound: 50000,
  casino: 50000,
  aviator: 50000,
  aviatorX: 50000,
  teenpatti: 50000,
  toss: 2000000,
  figure: 100000,
  even_odd: 2000000,
  tied_match: 500000
};

const DEFAULT_PROFIT_LIMITS = {
  isEnabled: true,
  maxProfit: 10000000,
  cricket: 5000000,
  soccer: 2000000,
  tennis: 1000000,
  fancy: 2000000,
  bookmaker: 2000000,
  casino: 500000,
  aviator: 500000,
  aviatorX: 500000,
  teenpatti: 500000,
  dailyProfitCap: 20000000
};

/**
 * Normalizes input game/market type to standardized category key
 */
function normalizeCategory(category) {
  if (!category) return 'cricket';
  const c = String(category).toLowerCase().trim();

  if (c.includes('aviatorx') || c.includes('aviator_x') || c === 'aviator-x') return 'aviatorX';
  if (c.includes('aviator')) return 'aviator';
  if (c.includes('teenpatti') || c.includes('teen_patti') || c.includes('teen-patti')) return 'teenpatti';
  if (c.includes('casino')) return 'casino';
  if (c.includes('soccer') || c.includes('football')) return 'soccer';
  if (c.includes('tennis')) return 'tennis';
  if (c.includes('fancy')) return 'fancy';
  if (c.includes('bookmaker')) return 'bookmaker';
  if (c.includes('toss')) return 'toss';
  if (c.includes('figure')) return 'figure';
  if (c.includes('even_odd') || c.includes('evenodd')) return 'even_odd';
  if (c.includes('tied_match') || c.includes('tied')) return 'tied_match';
  if (c.includes('race') || c.includes('horse')) return 'races';
  if (c.includes('greyhound')) return 'greyhound';
  if (c.includes('match_odds') || c.includes('cricket')) return 'cricket';

  return 'cricket';
}

function getCategoryDisplayName(cat) {
  const map = {
    cricket: 'Cricket',
    soccer: 'Soccer',
    tennis: 'Tennis',
    fancy: 'Fancy',
    bookmaker: 'BookMaker',
    races: 'Races',
    greyhound: 'Greyhound',
    casino: 'Casino',
    aviator: 'Aviator',
    aviatorX: 'Aviator X',
    teenpatti: 'Teen Patti',
    toss: 'Toss',
    figure: 'Figure',
    even_odd: 'Even/Odd',
    tied_match: 'Tied Match'
  };
  return map[cat] || cat;
}

/**
 * Resolves effective limits for a user by merging user settings and bounding
 * them by all parent/ancestor limits up the hierarchy chain.
 */
async function resolveUserEffectiveLimits(userOrKey) {
  let user = null;
  if (typeof userOrKey === 'string' || userOrKey instanceof String) {
    user = await hierarchyHelper.findUserByKey(userOrKey);
  } else if (userOrKey && userOrKey.username) {
    user = userOrKey;
  }

  if (!user) {
    return {
      user: null,
      bettingAllowed: false,
      effectiveMaxBetSizes: { ...DEFAULT_MAX_BET_SIZES },
      effectiveProfitLimits: { ...DEFAULT_PROFIT_LIMITS }
    };
  }

  // Get all ancestors up to superadmin
  const ancestors = await hierarchyHelper.getAncestorChain(user);

  // Initialize with user's own config or defaults
  const userMax = user.maxBetSizes || {};
  const effectiveMax = {};
  for (const [key, defVal] of Object.entries(DEFAULT_MAX_BET_SIZES)) {
    effectiveMax[key] = (typeof userMax[key] === 'number' && userMax[key] > 0) ? userMax[key] : defVal;
  }

  const userProfit = user.profitLimits || {};
  const effectiveProfit = {};
  for (const [key, defVal] of Object.entries(DEFAULT_PROFIT_LIMITS)) {
    if (typeof defVal === 'boolean') {
      effectiveProfit[key] = typeof userProfit[key] === 'boolean' ? userProfit[key] : defVal;
    } else {
      effectiveProfit[key] = (typeof userProfit[key] === 'number' && userProfit[key] > 0) ? userProfit[key] : defVal;
    }
  }

  // Check if betting is allowed along ancestor chain
  let chainBettingAllowed = user.bettingAllowed !== false && user.status === 'active';

  // Apply ancestor bounds (Child limit CANNOT exceed parent/ancestor limit)
  for (const ancestor of ancestors) {
    if (ancestor.status === 'inactive' || ancestor.bettingAllowed === false) {
      chainBettingAllowed = false;
    }

    if (ancestor.maxBetSizes) {
      for (const [k, limit] of Object.entries(ancestor.maxBetSizes)) {
        if (typeof limit === 'number' && limit > 0) {
          effectiveMax[k] = Math.min(effectiveMax[k] !== undefined ? effectiveMax[k] : limit, limit);
        }
      }
    }

    if (ancestor.profitLimits) {
      for (const [k, limit] of Object.entries(ancestor.profitLimits)) {
        if (typeof limit === 'number' && limit > 0) {
          effectiveProfit[k] = Math.min(effectiveProfit[k] !== undefined ? effectiveProfit[k] : limit, limit);
        }
      }
    }
  }

  return {
    user,
    bettingAllowed: chainBettingAllowed,
    effectiveMaxBetSizes: effectiveMax,
    effectiveProfitLimits: effectiveProfit
  };
}

/**
 * Validates a bet against user and ancestor max bet sizes & profit limits.
 * Throws an Error with a descriptive message if invalid.
 */
async function validateBetLimit(userOrKey, categoryRaw, stake, potentialProfit = 0) {
  const numStake = parseFloat(stake);
  if (isNaN(numStake) || numStake <= 0) {
    throw new Error('Invalid stake amount');
  }

  const category = normalizeCategory(categoryRaw);
  const displayName = getCategoryDisplayName(category);

  const { user, bettingAllowed, effectiveMaxBetSizes, effectiveProfitLimits } = await resolveUserEffectiveLimits(userOrKey);

  if (!user) {
    throw new Error('User not found');
  }

  if (!bettingAllowed) {
    throw new Error('Betting is currently disabled or account is inactive');
  }

  // 1. Max Bet Size validation
  const maxAllowedStake = effectiveMaxBetSizes[category] ?? DEFAULT_MAX_BET_SIZES[category] ?? 5000000;
  if (numStake > maxAllowedStake) {
    throw new Error(`Maximum bet size for ${displayName} is ₹${maxAllowedStake.toLocaleString('en-IN')}. Requested: ₹${numStake.toLocaleString('en-IN')}`);
  }

  // 2. Profit Limit validation
  const numProfit = parseFloat(potentialProfit);
  if (!isNaN(numProfit) && numProfit > 0 && effectiveProfitLimits.isEnabled) {
    const categoryProfitLimit = effectiveProfitLimits[category] ?? effectiveProfitLimits.maxProfit ?? DEFAULT_PROFIT_LIMITS.maxProfit;
    const overallProfitLimit = effectiveProfitLimits.maxProfit ?? DEFAULT_PROFIT_LIMITS.maxProfit;
    const effectiveLimit = Math.min(categoryProfitLimit, overallProfitLimit);

    if (numProfit > effectiveLimit) {
      throw new Error(`Potential profit of ₹${Math.round(numProfit).toLocaleString('en-IN')} exceeds maximum allowed profit limit of ₹${Math.round(effectiveLimit).toLocaleString('en-IN')} for ${displayName}`);
    }
  }

  return {
    valid: true,
    effectiveMaxStake: maxAllowedStake,
    effectiveProfitLimit: effectiveProfitLimits[category] || effectiveProfitLimits.maxProfit
  };
}

/**
 * Caps user settlement net profit if it exceeds configured profit limits
 */
async function capProfitByLimit(userOrKey, categoryRaw, rawProfit) {
  const profit = parseFloat(rawProfit);
  if (isNaN(profit) || profit <= 0) {
    return { netProfit: profit, wasCapped: false, originalProfit: rawProfit };
  }

  const category = normalizeCategory(categoryRaw);
  const { effectiveProfitLimits } = await resolveUserEffectiveLimits(userOrKey);

  if (!effectiveProfitLimits.isEnabled) {
    return { netProfit: profit, wasCapped: false, originalProfit: profit };
  }

  const categoryLimit = effectiveProfitLimits[category] ?? effectiveProfitLimits.maxProfit ?? DEFAULT_PROFIT_LIMITS.maxProfit;
  const overallLimit = effectiveProfitLimits.maxProfit ?? DEFAULT_PROFIT_LIMITS.maxProfit;
  const ceiling = Math.min(categoryLimit, overallLimit);

  if (profit > ceiling) {
    console.warn(`[PROFIT LIMIT ENFORCED] User ${typeof userOrKey === 'string' ? userOrKey : userOrKey.username} profit ₹${profit} capped to ₹${ceiling} for ${category}`);
    return {
      netProfit: ceiling,
      wasCapped: true,
      originalProfit: profit,
      capLimit: ceiling
    };
  }

  return { netProfit: profit, wasCapped: false, originalProfit: profit };
}

/**
 * Propagate max bet sizes and/or profit limits down to all child accounts
 */
async function applyLimitsToDownline(parentId, { maxBetSizes, profitLimits, updatedBy = 'system' }) {
  const descendants = await hierarchyHelper.getAllDescendants(parentId, '_id username parentId role maxBetSizes profitLimits');
  if (!descendants || descendants.length === 0) {
    return { count: 0 };
  }

  const updates = {};
  if (maxBetSizes) {
    for (const [k, v] of Object.entries(maxBetSizes)) {
      if (typeof v === 'number' && v > 0) {
        updates[`maxBetSizes.${k}`] = v;
      }
    }
  }

  if (profitLimits) {
    for (const [k, v] of Object.entries(profitLimits)) {
      if (typeof v === 'number' && v > 0) {
        updates[`profitLimits.${k}`] = v;
      } else if (typeof v === 'boolean') {
        updates[`profitLimits.${k}`] = v;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return { count: 0 };
  }

  const descendantIds = descendants.map(d => d._id);
  await User.updateMany({ _id: { $in: descendantIds } }, { $set: updates });

  // Keep UserProfitLimit collection synchronized
  if (profitLimits) {
    const profitUpdates = {};
    for (const [k, v] of Object.entries(profitLimits)) {
      if (['maxProfit', 'cricket', 'casino', 'aviator', 'aviatorX', 'teenpatti', 'soccer', 'tennis', 'fancy', 'bookmaker', 'dailyProfitCap', 'isEnabled'].includes(k)) {
        profitUpdates[k] = v;
      }
    }
    profitUpdates.lastUpdatedBy = updatedBy;
    profitUpdates.updatedAt = new Date();

    await UserProfitLimit.updateMany(
      { userId: { $in: descendantIds } },
      { $set: profitUpdates }
    );
  }

  return { count: descendants.length };
}

/**
 * Synchronize UserProfitLimit table record for a user
 */
async function syncUserProfitLimitRecord(user, parent = null, updatedBy = 'system') {
  if (!user || !user._id) return null;

  const profitLimits = user.profitLimits || {};
  const updateData = {
    userId: user._id,
    username: user.username,
    parentId: user.parentId || (parent ? parent._id : null),
    parentUsername: parent ? parent.username : null,
    role: user.role,
    maxProfit: profitLimits.maxProfit ?? DEFAULT_PROFIT_LIMITS.maxProfit,
    cricket: profitLimits.cricket ?? DEFAULT_PROFIT_LIMITS.cricket,
    casino: profitLimits.casino ?? DEFAULT_PROFIT_LIMITS.casino,
    aviator: profitLimits.aviator ?? DEFAULT_PROFIT_LIMITS.aviator,
    aviatorX: profitLimits.aviatorX ?? DEFAULT_PROFIT_LIMITS.aviatorX,
    teenpatti: profitLimits.teenpatti ?? DEFAULT_PROFIT_LIMITS.teenpatti,
    soccer: profitLimits.soccer ?? DEFAULT_PROFIT_LIMITS.soccer,
    tennis: profitLimits.tennis ?? DEFAULT_PROFIT_LIMITS.tennis,
    fancy: profitLimits.fancy ?? DEFAULT_PROFIT_LIMITS.fancy,
    bookmaker: profitLimits.bookmaker ?? DEFAULT_PROFIT_LIMITS.bookmaker,
    dailyProfitCap: profitLimits.dailyProfitCap ?? DEFAULT_PROFIT_LIMITS.dailyProfitCap,
    isEnabled: profitLimits.isEnabled ?? DEFAULT_PROFIT_LIMITS.isEnabled,
    lastUpdatedBy: updatedBy,
    updatedAt: new Date()
  };

  return await UserProfitLimit.findOneAndUpdate(
    { userId: user._id },
    { $set: updateData },
    { upsert: true, new: true }
  );
}

module.exports = {
  DEFAULT_MAX_BET_SIZES,
  DEFAULT_PROFIT_LIMITS,
  normalizeCategory,
  getCategoryDisplayName,
  resolveUserEffectiveLimits,
  validateBetLimit,
  capProfitByLimit,
  applyLimitsToDownline,
  syncUserProfitLimitRecord
};

