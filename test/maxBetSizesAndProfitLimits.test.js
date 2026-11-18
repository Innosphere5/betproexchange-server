const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  DEFAULT_MAX_BET_SIZES,
  DEFAULT_PROFIT_LIMITS,
  normalizeCategory,
  getCategoryDisplayName,
  resolveUserEffectiveLimits,
  validateBetLimit,
  capProfitByLimit,
  applyLimitsToDownline,
  syncUserProfitLimitRecord
} = require('../services/limitService');

test('Category Normalization: Maps all game and market variations correctly', () => {
  assert.equal(normalizeCategory('cricket'), 'cricket');
  assert.equal(normalizeCategory('match_odds'), 'cricket');
  assert.equal(normalizeCategory('casino'), 'casino');
  assert.equal(normalizeCategory('teenpatti'), 'teenpatti');
  assert.equal(normalizeCategory('teen_patti'), 'teenpatti');
  assert.equal(normalizeCategory('soccer'), 'soccer');
  assert.equal(normalizeCategory('football'), 'soccer');
  assert.equal(normalizeCategory('tennis'), 'tennis');
  assert.equal(normalizeCategory('bookmaker'), 'bookmaker');
  assert.equal(normalizeCategory('fancy'), 'fancy');
  assert.equal(normalizeCategory('races'), 'races');
  assert.equal(normalizeCategory('horse_racing'), 'races');
  assert.equal(normalizeCategory('greyhound'), 'greyhound');
  assert.equal(normalizeCategory(null), 'cricket');
});

test('Display Names: Proper human-readable game names', () => {
  assert.equal(getCategoryDisplayName('cricket'), 'Cricket');
  assert.equal(getCategoryDisplayName('casino'), 'Casino');
  assert.equal(getCategoryDisplayName('teenpatti'), 'Teen Patti');
  assert.equal(getCategoryDisplayName('bookmaker'), 'BookMaker');
  assert.equal(getCategoryDisplayName('soccer'), 'Soccer');
  assert.equal(getCategoryDisplayName('tennis'), 'Tennis');
});

test('Hierarchical Limits Resolution: Child is bounded by parent limits', async () => {
  const parentId = new mongoose.Types.ObjectId();
  const childId = new mongoose.Types.ObjectId();

  // Mock Parent (SuperMaster) with custom caps
  const parent = {
    _id: parentId,
    username: 'Malik50ADN',
    role: 'supermaster',
    status: 'active',
    bettingAllowed: true,
    maxBetSizes: {
      cricket: 3000000, // Parent capped at 3M
      casino: 40000,    // Parent capped at 40k
      teenpatti: 35000
    },
    profitLimits: {
      isEnabled: true,
      maxProfit: 5000000,
      cricket: 2500000,
      casino: 300000,
      teenpatti: 300000
    }
  };

  // Mock Child (Bettor) requesting higher caps than parent
  const child = {
    _id: childId,
    username: 'Asad670@',
    parentId: parentId,
    role: 'user',
    status: 'active',
    bettingAllowed: true,
    maxBetSizes: {
      cricket: 5000000, // Child requests 5M (should be bounded to 3M)
      casino: 50000,    // Child requests 50k (should be bounded to 40k)
      teenpatti: 50000  // Should be bounded to 35k
    },
    profitLimits: {
      isEnabled: true,
      maxProfit: 10000000,
      cricket: 5000000,
      casino: 500000,
      teenpatti: 500000
    }
  };

  const hierarchyHelper = require('../services/hierarchyHelper');
  const originalGetAncestorChain = hierarchyHelper.getAncestorChain;
  hierarchyHelper.getAncestorChain = async () => [parent];

  try {
    const effective = await resolveUserEffectiveLimits(child);

    // Verify max bet sizes are capped to parent ceilings
    assert.equal(effective.effectiveMaxBetSizes.cricket, 3000000);
    assert.equal(effective.effectiveMaxBetSizes.casino, 40000);
    assert.equal(effective.effectiveMaxBetSizes.teenpatti, 35000);

    // Verify profit limits are capped to parent ceilings
    assert.equal(effective.effectiveProfitLimits.maxProfit, 5000000);
    assert.equal(effective.effectiveProfitLimits.cricket, 2500000);
    assert.equal(effective.effectiveProfitLimits.casino, 300000);
    assert.equal(effective.effectiveProfitLimits.teenpatti, 300000);
  } finally {
    hierarchyHelper.getAncestorChain = originalGetAncestorChain;
  }
});

test('Bet Validation: Stakes within max bet sizes pass', async () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    username: 'testbettor',
    status: 'active',
    bettingAllowed: true,
    maxBetSizes: { ...DEFAULT_MAX_BET_SIZES }
  };

  const hierarchyHelper = require('../services/hierarchyHelper');
  const originalGetAncestorChain = hierarchyHelper.getAncestorChain;
  hierarchyHelper.getAncestorChain = async () => [];

  try {
    // Cricket bet of 100k (default limit 5M)
    const cricketRes = await validateBetLimit(user, 'cricket', 100000, 90000);
    assert.equal(cricketRes.valid, true);

    // Casino bet of 20k (default limit 50k)
    const casinoRes = await validateBetLimit(user, 'casino', 20000, 20000);
    assert.equal(casinoRes.valid, true);

    // Teen Patti bet of 25k (default limit 50k)
    const teenpattiRes = await validateBetLimit(user, 'teenpatti', 25000, 24000);
    assert.equal(teenpattiRes.valid, true);
  } finally {
    hierarchyHelper.getAncestorChain = originalGetAncestorChain;
  }
});

test('Bet Validation: Exceeding max bet size is rejected with informative error', async () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    username: 'testbettor2',
    status: 'active',
    bettingAllowed: true,
    maxBetSizes: {
      casino: 15000,
      cricket: 1000000,
      teenpatti: 20000
    }
  };

  const hierarchyHelper = require('../services/hierarchyHelper');
  const originalGetAncestorChain = hierarchyHelper.getAncestorChain;
  hierarchyHelper.getAncestorChain = async () => [];

  try {
    // Casino over bet
    await assert.rejects(
      async () => await validateBetLimit(user, 'casino', 20000),
      /Maximum bet size for Casino is ₹15,000/
    );

    // Teen Patti over bet
    await assert.rejects(
      async () => await validateBetLimit(user, 'teenpatti', 50000),
      /Maximum bet size for Teen Patti is ₹20,000/
    );

    // Cricket over bet
    await assert.rejects(
      async () => await validateBetLimit(user, 'cricket', 1500000),
      /Maximum bet size for Cricket is/
    );
  } finally {
    hierarchyHelper.getAncestorChain = originalGetAncestorChain;
  }
});

test('Profit Limit Validation: Rejects bets exceeding potential profit ceiling', async () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    username: 'testbettor3',
    status: 'active',
    bettingAllowed: true,
    maxBetSizes: { cricket: 5000000 },
    profitLimits: {
      isEnabled: true,
      maxProfit: 2000000,
      cricket: 1500000
    }
  };

  const hierarchyHelper = require('../services/hierarchyHelper');
  const originalGetAncestorChain = hierarchyHelper.getAncestorChain;
  hierarchyHelper.getAncestorChain = async () => [];

  try {
    // Stake is within 5M, but odds 10.0 gives potential profit 900k * 9 = 8.1M which exceeds 1.5M profit limit
    await assert.rejects(
      async () => await validateBetLimit(user, 'cricket', 900000, 8100000),
      /exceeds maximum allowed profit limit/
    );
  } finally {
    hierarchyHelper.getAncestorChain = originalGetAncestorChain;
  }
});

test('Profit Capping at Settlement: Enforces net profit ceilings accurately', async () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    username: 'winneruser',
    status: 'active',
    bettingAllowed: true,
    profitLimits: {
      isEnabled: true,
      maxProfit: 1000000,
      casino: 200000,
      teenpatti: 200000
    }
  };

  const hierarchyHelper = require('../services/hierarchyHelper');
  const originalGetAncestorChain = hierarchyHelper.getAncestorChain;
  hierarchyHelper.getAncestorChain = async () => [];

  try {
    // Casino win of 500,000 capped to 200,000
    const casinoResult = await capProfitByLimit(user, 'casino', 500000);
    assert.equal(casinoResult.wasCapped, true);
    assert.equal(casinoResult.netProfit, 200000);

    // Teen Patti win of 300,000 capped to 200,000
    const teenpattiResult = await capProfitByLimit(user, 'teenpatti', 300000);
    assert.equal(teenpattiResult.wasCapped, true);
    assert.equal(teenpattiResult.netProfit, 200000);
  } finally {
    hierarchyHelper.getAncestorChain = originalGetAncestorChain;
  }
});

test('Inactive / Betting Disallowed: Rejects immediately', async () => {
  const inactiveUser = {
    _id: new mongoose.Types.ObjectId(),
    username: 'banneduser',
    status: 'inactive',
    bettingAllowed: true
  };

  const disallowedUser = {
    _id: new mongoose.Types.ObjectId(),
    username: 'nobetsuser',
    status: 'active',
    bettingAllowed: false
  };

  const hierarchyHelper = require('../services/hierarchyHelper');
  const originalGetAncestorChain = hierarchyHelper.getAncestorChain;
  hierarchyHelper.getAncestorChain = async () => [];

  try {
    await assert.rejects(
      async () => await validateBetLimit(inactiveUser, 'cricket', 100),
      /Betting is currently disabled or account is inactive/
    );

    await assert.rejects(
      async () => await validateBetLimit(disallowedUser, 'casino', 100),
      /Betting is currently disabled or account is inactive/
    );
  } finally {
    hierarchyHelper.getAncestorChain = originalGetAncestorChain;
  }
});
