const SUPERADMIN_DISPLAY_BALANCE = 100000;

/**
 * Returns true if the given user object or role string is `superadmin`.
 */
function isSuperAdminRole(roleOrUser) {
  if (!roleOrUser) return false;
  const role = typeof roleOrUser === 'string' ? roleOrUser : roleOrUser.role;
  return role === 'superadmin';
}

/**
 * SuperAdmin displays a fixed 100,000 wallet balance while having unlimited spending capability.
 * All other roles strictly reflect their real database walletBalance.
 */
function getEffectiveWalletBalance(user) {
  if (!user) return 0;
  if (isSuperAdminRole(user)) return SUPERADMIN_DISPLAY_BALANCE;
  return user.walletBalance || 0;
}

module.exports = {
  SUPERADMIN_DISPLAY_BALANCE,
  isSuperAdminRole,
  getEffectiveWalletBalance,
};
