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

test('Current Position Loss / Profit Calculation on Cricket Odds with 5% Commission', () => {
  // Scenario: Bettor bets Back 10,000 on Team A @ 2.0
  const stake = 10000;
  const odds = 2.0;
  const COMMISSION_RATE = 0.05;
  const netShare = 20; // 20% parent share (e.g. SuperMaster)

  // If Team A wins: Bettor wins gross 10,000. Commission is 500. Net bettor win is 9,500.
  // House/Parent loses 9,500 * 20% = -1,900.
  const userGrossWin = (odds - 1) * stake;
  const netUserWin = userGrossWin * (1 - COMMISSION_RATE);
  const parentExposureTeamAWins = - (netUserWin * (netShare / 100));
  assert.equal(parentExposureTeamAWins, -1900, 'Parent should show -1,900 loss if Team A wins');

  // If Team B wins (Team A loses): Bettor loses stake 10,000.
  // House/Parent wins 10,000 * 20% = +2,000.
  const parentExposureTeamBWins = stake * (netShare / 100);
  assert.equal(parentExposureTeamBWins, 2000, 'Parent should show +2,000 profit if Team B wins');
});

test('Current Position Lay Bet Exposure on Cricket Odds', () => {
  // Scenario: Bettor bets Lay 10,000 on Team A @ 2.5 (Liability = 15,000)
  const stake = 10000;
  const odds = 2.5;
  const liability = (odds - 1) * stake; // 15,000
  const netShare = 30; // 30% parent share

  // If Team A wins: Bettor lost their lay bet! Bettor loses liability of 15,000.
  // House/Parent wins liability * share% = 15,000 * 0.30 = +4,500.
  const parentExposureTeamAWins = liability * (netShare / 100);
  assert.equal(parentExposureTeamAWins, 4500, 'Parent should show +4,500 profit if Team A wins (Lay bettor lost liability)');

  // If Team B wins: Bettor won lay bet! Bettor wins stake 10,000. Commission 500. Net 9,500.
  // House/Parent loses 9,500 * 0.30 = -2,850.
  const netWin = stake * (1 - 0.05);
  const parentExposureTeamBWins = -(netWin * (netShare / 100));
  assert.equal(parentExposureTeamBWins, -2850, 'Parent should show -2,850 loss if Team B wins (Lay bettor won)');
});
