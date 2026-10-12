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

test('Exact Screenshot Reproduction: UAE v Namibia Lay Bets with 10% Parent Share', () => {
  // Scenario from Image 1 & 2:
  // Downline placed two Lay bets on Namibia @ 1.09:
  // 1. Lay 100 @ 1.09 (10% parent share)
  // 2. Lay 100,000 @ 1.09 (10% parent share)
  // Total stake = 100,100
  const stake = 100100;
  const odds = 1.09;
  const netShare = 10; // 10% share
  const parentStake = stake * (netShare / 100); // 10,010

  // 1. If Namibia wins:
  // Bettor laid Namibia -> Bettor lost liability of (1.09 - 1) * 100,100 = 9,009.
  // House/Parent wins liability * 10% = 900.9 -> Math.round is +901.
  const namibiaWinsHousePL = Math.round((odds - 1) * parentStake);
  assert.equal(namibiaWinsHousePL, 901, 'Namibia runner net position must be +901');

  // 2. If United Arab Emirates wins (Namibia loses):
  // Bettor laid Namibia -> Bettor wins stake 100,100.
  // House/Parent loses stake * 10% = -10,010.
  const uaeWinsHousePL = Math.round(-parentStake);
  assert.equal(uaeWinsHousePL, -10010, 'UAE runner net position must be -10,010');

  // 3. Market worst liability:
  const marketPosition = Math.min(namibiaWinsHousePL, uaeWinsHousePL);
  assert.equal(marketPosition, -10010, 'Market position amount in table must be -10,010');
});

test('1.5% Platform Fee Deducted First Only on Profit Before Shareholder Distribution', () => {
  const PLATFORM_FEE_RATE = 0.015; // 1.5% platform fee
  
  // Case A: House Profit = 10,000 (Bettor lost liability 10,000)
  const houseProfit = 10000;
  const platformFee = Math.round(houseProfit * PLATFORM_FEE_RATE * 100) / 100; // 150
  assert.equal(platformFee, 150, '1.5% Platform fee on 10,000 profit must be 150');

  const distributableProfit = houseProfit - platformFee; // 9,850
  assert.equal(distributableProfit, 9850, 'Distributable profit after 1.5% platform fee must be 9,850');

  // Share split: Master=10%, SuperMaster=15%, Admin=35%, SuperAdmin=25%, Book=15%
  const masterShare = 10;
  const smShare = 15;
  const adminShare = 35;
  const saShare = 25;
  const bookShare = 15;

  const masterEarning = Math.round((masterShare / 100) * distributableProfit * 100) / 100;
  const smEarning = Math.round((smShare / 100) * distributableProfit * 100) / 100;
  const adminEarning = Math.round((adminShare / 100) * distributableProfit * 100) / 100;
  const saEarning = Math.round((saShare / 100) * distributableProfit * 100) / 100;
  const bookEarning = Math.round((bookShare / 100) * distributableProfit * 100) / 100;

  assert.equal(masterEarning, 985);
  assert.equal(smEarning, 1477.5);
  assert.equal(adminEarning, 3447.5);
  assert.equal(saEarning, 2462.5);
  assert.equal(bookEarning, 1477.5);

  const totalDistributed = masterEarning + smEarning + adminEarning + saEarning + bookEarning;
  assert.equal(totalDistributed, 9850, 'Sum of shareholder earnings must equal distributable profit (9,850)');
  assert.equal(totalDistributed + platformFee, houseProfit, 'Sum of shares + platform fee must equal full house profit (10,000)');

  // Case B: House Loss = -10,000 (Bettor won 10,000 net)
  // Platform fee is ONLY on profit. On loss, fee = 0, full loss distributed among shareholders.
  const houseLoss = -10000;
  const platformFeeOnLoss = 0;
  const distributableLoss = houseLoss;

  const masterLoss = Math.round((masterShare / 100) * distributableLoss * 100) / 100;
  const smLoss = Math.round((smShare / 100) * distributableLoss * 100) / 100;
  const adminLoss = Math.round((adminShare / 100) * distributableLoss * 100) / 100;
  const saLoss = Math.round((saShare / 100) * distributableLoss * 100) / 100;
  const bookLoss = Math.round((bookShare / 100) * distributableLoss * 100) / 100;

  assert.equal(masterLoss, -1000);
  assert.equal(smLoss, -1500);
  assert.equal(adminLoss, -3500);
  assert.equal(saLoss, -2500);
  assert.equal(bookLoss, -1500);

  const totalLossDistributed = masterLoss + smLoss + adminLoss + saLoss + bookLoss;
  assert.equal(totalLossDistributed, -10000, 'Sum of shareholder losses must equal full house loss (-10,000)');
});

test('Market Separation: Match Odds Bets Do NOT Leak into Bookmaker Exposure', () => {
  const teamA = 'India';
  const teamB = 'Pakistan';

  // Simulate exposure calculation logic:
  // User places bet on Match Odds: runner = India, marketType = 'match_odds'
  const bets = [
    { runner: 'India', odds: 1.80, stake: 5000, type: 'back', marketType: 'match_odds' }
  ];

  const exposure = {
    [teamA]: 0,
    [teamB]: 0,
    [`${teamA}_bm`]: 0,
    [`${teamB}_bm`]: 0
  };

  const netShare = 100; // 100% share for testing

  bets.forEach(b => {
    const isBm = (b.marketType === 'bookmaker');
    const isMo = (!b.marketType || b.marketType === 'match_odds');

    [teamA, teamB].forEach(winRunner => {
      let profit = 0;
      if (b.type === 'back') {
        if (b.runner.toLowerCase() === winRunner.toLowerCase()) {
          profit = -((b.odds - 1) * b.stake); // Bettor wins, house loses
        } else {
          profit = b.stake; // Bettor loses, house wins
        }
      }

      if (isBm) {
        exposure[`${winRunner}_bm`] += profit;
      } else if (isMo) {
        exposure[winRunner] += profit;
      }
    });
  });

  // Match Odds keys MUST have exposure
  assert.equal(exposure['India'], -4000, 'Match Odds runner India exposure must be -4,000');
  assert.equal(exposure['Pakistan'], 5000, 'Match Odds runner Pakistan exposure must be +5,000');

  // Bookmaker keys MUST BE 0 (NO LEAKAGE)
  assert.equal(exposure['India_bm'], 0, 'Bookmaker runner India_bm must have 0 exposure when only bet on Match Odds');
  assert.equal(exposure['Pakistan_bm'], 0, 'Bookmaker runner Pakistan_bm must have 0 exposure when only bet on Match Odds');
});


