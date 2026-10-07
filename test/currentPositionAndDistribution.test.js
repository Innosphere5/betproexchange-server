'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getViewerNetShare } = require('../services/hierarchyHelper');

test('Universal Hierarchy Share Split: 4-tier chain (Master, SuperMaster, Admin, SuperAdmin, Book)', () => {
  const sa = { _id: 'sa1', username: 'superadmin1', role: 'superadmin', share: 85 };
  const admin = { _id: 'a1', username: 'admin1', role: 'admin', share: 60, parentId: 'sa1' };
  const sm = { _id: 'sm1', username: 'supermaster1', role: 'supermaster', share: 25, parentId: 'a1' };
  const master = { _id: 'm1', username: 'master1', role: 'master', share: 10, parentId: 'sm1' };
  const bettor = { _id: 'u1', username: 'bettor1', role: 'user', parentId: 'm1' };

  const userMap = {
    sa1: sa, superadmin1: sa,
    a1: admin, admin1: admin,
    sm1: sm, supermaster1: sm,
    m1: master, master1: master,
    u1: bettor, bettor1: bettor
  };

  const masterShare = getViewerNetShare(master, bettor, userMap);
  const smShare = getViewerNetShare(sm, bettor, userMap);
  const adminShare = getViewerNetShare(admin, bettor, userMap);
  const saShare = getViewerNetShare(sa, bettor, userMap);
  const bookShare = 100 - (sa.share ?? 85);

  // Master: 10%
  assert.equal(masterShare, 10, 'Master should receive 10% direct share');
  // SuperMaster: max(0, 25 - 10) = 15%
  assert.equal(smShare, 15, 'SuperMaster should receive 15% net share');
  // Admin: max(0, 60 - 25) = 35%
  assert.equal(adminShare, 35, 'Admin should receive 35% net share');
  // SuperAdmin: max(0, 85 - 60) = 25%
  assert.equal(saShare, 25, 'SuperAdmin should receive 25% net share');
  // Book: 100 - 85 = 15%
  assert.equal(bookShare, 15, 'Book should receive 15% share');

  // Sum of all shares must be exactly 100%
  const total = masterShare + smShare + adminShare + saShare + bookShare;
  assert.equal(total, 100, 'Total hierarchy + book share must equal 100%');
});

test('Universal Hierarchy Share Split: 3-tier chain without SuperMaster', () => {
  const sa = { _id: 'sa1', username: 'superadmin1', role: 'superadmin', share: 85 };
  const admin = { _id: 'a1', username: 'admin1', role: 'admin', share: 50, parentId: 'sa1' };
  const master = { _id: 'm1', username: 'master1', role: 'master', share: 15, parentId: 'a1' };
  const bettor = { _id: 'u1', username: 'bettor1', role: 'user', parentId: 'm1' };

  const userMap = {
    sa1: sa, superadmin1: sa,
    a1: admin, admin1: admin,
    m1: master, master1: master,
    u1: bettor, bettor1: bettor
  };

  const masterShare = getViewerNetShare(master, bettor, userMap);
  const adminShare = getViewerNetShare(admin, bettor, userMap);
  const saShare = getViewerNetShare(sa, bettor, userMap);
  const bookShare = 100 - sa.share;

  assert.equal(masterShare, 15);
  assert.equal(adminShare, 35); // 50 - 15
  assert.equal(saShare, 35);    // 85 - 50
  assert.equal(bookShare, 15);

  assert.equal(masterShare + adminShare + saShare + bookShare, 100);
});

test('Universal Hierarchy Share Split: Direct child of SuperAdmin with 100% share', () => {
  const sa = { _id: 'sa1', username: 'superadmin1', role: 'superadmin', share: 100 };
  const bettor = { _id: 'u1', username: 'bettor1', role: 'user', parentId: 'sa1' };

  const userMap = {
    sa1: sa, superadmin1: sa,
    u1: bettor, bettor1: bettor
  };

  const saShare = getViewerNetShare(sa, bettor, userMap);
  const bookShare = 100 - sa.share;

  assert.equal(saShare, 100);
  assert.equal(bookShare, 0);
  assert.equal(saShare + bookShare, 100);
});

test('Current Position Live Bet Exposure (Full Gross Share Without Deducted Commission)', () => {
  // Scenario: Bettor bets Back 10,000 on Team A @ 2.0
  const stake = 10000;
  const odds = 2.0;
  const netShare = 20; // 20% parent share (e.g. SuperMaster)

  // During LIVE / OPEN bet (before result):
  // Show full gross amount according to share, WITHOUT deducted commission:
  // If Team A wins: Bettor gross win is (2.0 - 1) * 10,000 = 10,000.
  // House/Parent loss is -10,000 * 20% = -2,000 (Full gross amount, NO commission deducted).
  const userGrossWin = (odds - 1) * stake;
  const liveParentExposureTeamAWins = -(userGrossWin * (netShare / 100));
  assert.equal(liveParentExposureTeamAWins, -2000, 'Live current position must show full gross amount of -2,000 without deducted commission');

  // If Team B wins (Team A loses): Bettor loses stake 10,000.
  // House/Parent wins 10,000 * 20% = +2,000.
  const liveParentExposureTeamBWins = stake * (netShare / 100);
  assert.equal(liveParentExposureTeamBWins, 2000, 'Live current position must show +2,000 profit if Team B wins');
});

test('Current Position Settled Bet Outcome (Commission Deducted After Bet Result)', () => {
  // Scenario: Bettor bet Back 10,000 on Team A @ 2.0. Result is declared (Team A won).
  const stake = 10000;
  const odds = 2.0;
  const COMMISSION_RATE = 0.05; // 5% exchange commission
  const netShare = 20; // 20% parent share

  // AFTER RESULT IS DECLARED: Commission is deducted from winning amount:
  // Gross win = 10,000. Commission = 500. Net bettor win = 9,500.
  // House/Parent loss = -9,500 * 20% = -1,900.
  const userGrossWin = (odds - 1) * stake;
  const netUserWin = userGrossWin * (1 - COMMISSION_RATE);
  const settledParentExposureTeamAWins = -(netUserWin * (netShare / 100));
  assert.equal(settledParentExposureTeamAWins, -1900, 'Settled position must deduct 5% commission after result, showing -1,900 loss');
});

test('Current Position Lay Bet Exposure: Live Full Share vs Settled Outcome', () => {
  // Scenario: Bettor bets Lay 10,000 on Team A @ 2.5 (Liability = 15,000)
  const stake = 10000;
  const odds = 2.5;
  const liability = (odds - 1) * stake; // 15,000
  const COMMISSION_RATE = 0.05;
  const netShare = 30; // 30% parent share

  // LIVE / BEFORE RESULT:
  // If Team A wins: Bettor lost lay liability of 15,000.
  // House/Parent wins liability * share% = 15,000 * 0.30 = +4,500.
  const liveParentExposureTeamAWins = liability * (netShare / 100);
  assert.equal(liveParentExposureTeamAWins, 4500, 'Parent shows +4,500 profit if Team A wins (Lay bettor lost liability)');

  // If Team B wins (Lay bettor wins): Gross win is stake 10,000.
  // LIVE position shows full gross share without commission: -10,000 * 30% = -3,000.
  const liveParentExposureTeamBWins = -(stake * (netShare / 100));
  assert.equal(liveParentExposureTeamBWins, -3000, 'Live position shows full gross amount of -3,000 without deducted commission');

  // SETTLED / AFTER RESULT:
  // Commission 500 is deducted from winning stake: Net win = 9,500.
  // House/Parent loss is -9,500 * 30% = -2,850.
  const netLayWin = stake * (1 - COMMISSION_RATE);
  const settledParentExposureTeamBWins = -(netLayWin * (netShare / 100));
  assert.equal(settledParentExposureTeamBWins, -2850, 'Settled position deducts 5% commission after result, showing -2,850 loss');
});

