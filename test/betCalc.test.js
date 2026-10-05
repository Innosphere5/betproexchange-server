'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SIDE, FANCY, oddsBet, oddsBook, previewOdds, fancyBet, fancyBook,
  accountSummary, formatUnits, formatCompact, slipProfitText
} = require('../utils/betCalc');

const GRB = ['GRB', 'ECL'];

test('Match Odds: back GRB 1.68, stake 10,000', () => {
  const b = oddsBet({ side: SIDE.BACK, selection: 'GRB', stake: 10000, odds: 1.68 });
  const { pl, exposure } = oddsBook([b], GRB);
  assert.deepEqual(pl, { GRB: 6800, ECL: -10000 });
  assert.equal(exposure, 10000);
});

test('Match Odds: lay ECL 2.46, stake 10,000 -> liability 14,600', () => {
  const b = oddsBet({ side: SIDE.LAY, selection: 'ECL', stake: 10000, odds: 2.46 });
  assert.equal(b.liability, 14600);
  const { pl, exposure } = oddsBook([b], GRB);
  assert.deepEqual(pl, { GRB: 10000, ECL: -14600 });
  assert.equal(exposure, 14600);
});

test('Bookmaker: back ECL 2.43, stake 10,000', () => {
  const b = oddsBet({ side: SIDE.BACK, selection: 'ECL', stake: 10000, odds: 2.43 });
  assert.deepEqual(oddsBook([b], GRB).pl, { GRB: -10000, ECL: 14300 });
});

test('Figure: 500 on digit 0 at 8.85 -> +3,925, every other digit -500', () => {
  const digits = ['0','1','2','3','4','5','6','7','8','9'];
  const b = oddsBet({ side: SIDE.BACK, selection: '0', stake: 500, odds: 8.85 });
  const { pl, exposure } = oddsBook([b], digits);
  assert.equal(pl['0'], 3925);
  for (const d of digits.slice(1)) assert.equal(pl[d], -500);
  assert.equal(exposure, 500);
});

test('Even/Odd: back 1.98, stake 1,000', () => {
  const b = oddsBet({ side: SIDE.BACK, selection: 'ODD', stake: 1000, odds: 1.98 });
  assert.deepEqual(oddsBook([b], ['ODD', 'EVEN']).pl, { ODD: 980, EVEN: -1000 });
});

test('Commission 2% is taken from net profit only', () => {
  const b = oddsBet({ side: SIDE.BACK, selection: 'GRB', stake: 10000, odds: 1.68 });
  const { pl } = oddsBook([b], GRB, { commissionBps: 200 });
  assert.deepEqual(pl, { GRB: 6664, ECL: -10000 });
});

test('Netting: back and lay the same runner combine into one book', () => {
  const a = oddsBet({ side: SIDE.BACK, selection: 'GRB', stake: 10000, odds: 1.68 });
  const l = oddsBet({ side: SIDE.LAY, selection: 'GRB', stake: 5000, odds: 1.69 });
  const { pl } = oddsBook([a, l], GRB);
  assert.deepEqual(pl, { GRB: 6800 - 3450, ECL: -10000 + 5000 });
});

test('Preview shows exposure change before confirming', () => {
  const a = oddsBet({ side: SIDE.BACK, selection: 'GRB', stake: 10000, odds: 1.68 });
  const l = oddsBet({ side: SIDE.LAY, selection: 'GRB', stake: 5000, odds: 1.69 });
  const p = previewOdds([a], l, GRB);
  assert.equal(p.before.exposure, 10000);
  assert.equal(p.after.exposure, 5000);
  assert.equal(p.exposureChange, -5000);
});

test('Fancy: Yes 53 rate 100, stake 1,000', () => {
  const b = fancyBet({ side: FANCY.YES, line: 53, rate: 100, stake: 1000 });
  const { ladder, exposure } = fancyBook([b], 45, 60);
  assert.equal(ladder.find(x => x.total === 60).pl, 1000);
  assert.equal(ladder.find(x => x.total === 53).pl, 1000);
  assert.equal(ladder.find(x => x.total === 52).pl, -1000);
  assert.equal(exposure, 1000);
});

test('Fancy: No 52 rate 100, stake 1,000', () => {
  const b = fancyBet({ side: FANCY.NO, line: 52, rate: 100, stake: 1000 });
  const { ladder } = fancyBook([b], 45, 60);
  assert.equal(ladder.find(x => x.total === 51).pl, 1000);
  assert.equal(ladder.find(x => x.total === 52).pl, -1000);
});

test('Fancy rates: Back 46 @90 and Lay 46 @110, stake 1,000', () => {
  const y = fancyBet({ side: FANCY.YES, line: 46, rate: 90, stake: 1000 });
  const n = fancyBet({ side: FANCY.NO, line: 46, rate: 110, stake: 1000 });
  assert.equal(y.potentialProfit, 900);
  assert.equal(y.liability, 1000);
  assert.equal(n.potentialProfit, 1000);
  assert.equal(n.liability, 1100);
});

test('Fancy book: Yes 46 and No 50 gives a mid-range window', () => {
  const y = fancyBet({ side: FANCY.YES, line: 46, rate: 100, stake: 1000 });
  const n = fancyBet({ side: FANCY.NO, line: 50, rate: 100, stake: 1000 });
  const { ladder, exposure } = fancyBook([y, n], 40, 55);
  const at = t => ladder.find(x => x.total === t).pl;
  assert.equal(at(45), -1000 + 1000);   // Yes loses, No wins
  assert.equal(at(48), 1000 + 1000);    // both win
  assert.equal(at(52), 1000 - 1000);    // Yes wins, No loses
  assert.equal(exposure, 0);
});

test('Validation rejects bad input', () => {
  assert.throws(() => oddsBet({ side: SIDE.BACK, selection: 'A', stake: 10.5, odds: 2 }));
  assert.throws(() => oddsBet({ side: SIDE.BACK, selection: 'A', stake: 100, odds: 1 }));
  assert.throws(() => oddsBet({ side: SIDE.BACK, selection: 'A', stake: 100, odds: 2.345 }));
  assert.throws(() => fancyBet({ side: 'MAYBE', line: 10, rate: 100, stake: 100 }));
});

/* ---- Scenarios taken from the reference screenshots (4 Oct 2026) ---- */

test('Screenshot 1: bet slip back India Legends 1.7, stake 2,000 shows "1,400 / -2,000"', () => {
  const b = oddsBet({ side: SIDE.BACK, selection: 'IND', stake: 2000, odds: 1.7 });
  assert.equal(slipProfitText(b), '1,400 / -2,000');
});

test('Screenshot 2: lay Toss 2,000 @2.02 -> runner -2,040, B 2,420, L -2,040', () => {
  const lay = oddsBet({ side: SIDE.LAY, selection: 'IND_TOSS', stake: 2000, odds: 2.02 });
  const book = oddsBook([lay], ['IND_TOSS', 'NOT']);
  assert.equal(book.pl.IND_TOSS, -2040);
  assert.equal(book.exposure, 2040);
  assert.deepEqual(accountSummary(4460, [book.exposure]), { balance: 2420, liability: -2040 });
});

test('Screenshot 3: back WI 2,000 @5.1 -> WI +8,200, SA -2,000; header B 420, L -4,040', () => {
  const lay = oddsBet({ side: SIDE.LAY, selection: 'IND_TOSS', stake: 2000, odds: 2.02 });
  const tossBook = oddsBook([lay], ['IND_TOSS', 'NOT']);
  const back = oddsBet({ side: SIDE.BACK, selection: 'WI', stake: 2000, odds: 5.1 });
  const mo = oddsBook([back], ['WI', 'SA']);
  assert.deepEqual(mo.pl, { WI: 8200, SA: -2000 });
  assert.deepEqual(accountSummary(4460, [tossBook.exposure, mo.exposure]), { balance: 420, liability: -4040 });
});

test('Header with no bets: B equals equity, L is 0', () => {
  assert.deepEqual(accountSummary(4460, []), { balance: 4460, liability: 0 });
});

test('Formatting matches the screens', () => {
  assert.equal(formatUnits(1400), '1,400');
  assert.equal(formatUnits(-2040), '-2,040');
  assert.equal(formatUnits(8200), '8,200');
  assert.deepEqual([720, 1200, 378200, 767500, 14000000, 6900000, 98].map(formatCompact),
    ['720', '1.2K', '378.2K', '767.5K', '14.0M', '6.9M', '98']);
});
