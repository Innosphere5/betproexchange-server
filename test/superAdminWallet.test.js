const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SUPERADMIN_DISPLAY_BALANCE,
  isSuperAdminRole,
  getEffectiveWalletBalance,
} = require('../utils/superAdminWallet');

test('SuperAdmin displays fixed 100,000 wallet balance regardless of stored DB value', () => {
  assert.equal(SUPERADMIN_DISPLAY_BALANCE, 100000);
  assert.equal(isSuperAdminRole({ role: 'superadmin' }), true);
  assert.equal(getEffectiveWalletBalance({ role: 'superadmin', walletBalance: 0 }), 100000);
  assert.equal(getEffectiveWalletBalance({ role: 'superadmin', walletBalance: 9999999 }), 100000);
});

test('Non-superadmin roles strictly use real stored walletBalance', () => {
  for (const role of ['admin', 'supermaster', 'master', 'user']) {
    assert.equal(isSuperAdminRole({ role }), false);
    assert.equal(getEffectiveWalletBalance({ role, walletBalance: 25000 }), 25000);
    assert.equal(getEffectiveWalletBalance({ role, walletBalance: 0 }), 0);
  }
});
