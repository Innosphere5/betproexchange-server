'use strict';
/**
 * betCalc.js - pure profit/loss functions for exchange-style markets.
 *
 * Covers: Match Odds, Bookmaker, Figure (digits 0-9), Even/Odd  -> oddsBook()
 *         Fancy / session (line + rate)                          -> fancyBook()
 *
 * All money is an INTEGER in minor units (paise, cents or points) so there is
 * no floating-point drift. Odds are decimal with at most 2 decimals (1.68, 8.85).
 *
 * Positive number = profit, negative = loss, for the outcome in question.
 *
 * ASSUMPTIONS (confirm against your own platform rules):
 *  - Odds are decimal: back win = stake x (odds - 1); lay liability = stake x (odds - 1).
 *  - Commission, if any, is charged on NET profit of a market result, never on a loss.
 *  - Fancy: Yes wins stake x rate/100, No loses stake x rate/100 (and vice versa).
 *  These follow the standard published exchange model and the screenshots supplied;
 *  they are not copied from any particular site's code.
 */

const SIDE = Object.freeze({ BACK: 'BACK', LAY: 'LAY' });
const FANCY = Object.freeze({ YES: 'YES', NO: 'NO' });

function assertInt(v, name) {
  if (!Number.isInteger(v) || v <= 0) throw new RangeError(`${name} must be a positive integer (minor units)`);
}

// odds -> hundredths, so 8.85 becomes 885 exactly
function oddsX100(odds) {
  if (typeof odds !== 'number' || !(odds > 1)) throw new RangeError('odds must be a number greater than 1');
  const x = Math.round(odds * 100);
  if (Math.abs(x / 100 - odds) > 1e-9) throw new RangeError('odds may have at most 2 decimals');
  return x;
}

// round half away from zero, integers only
function roundDiv(n, d) {
  const q = Math.abs(n) / d;
  const r = Math.floor(q + 0.5);
  return n < 0 ? -r : r;
}

/* ---------- Odds markets (Match Odds, Bookmaker, Figure, Even/Odd) ---------- */

function oddsBet({ side, selection, stake, odds }) {
  const s = typeof side === 'string' ? side.toUpperCase() : side;
  if (s !== SIDE.BACK && s !== SIDE.LAY) throw new RangeError('side must be BACK or LAY');
  if (selection === undefined || selection === null || selection === '') throw new RangeError('selection required');
  assertInt(stake, 'stake');
  const o = oddsX100(odds);
  const winAmount = roundDiv(stake * (o - 100), 100); // stake x (odds - 1)
  return Object.freeze({
    side: s, selection: String(selection), stake, odds,
    // BACK: risk the stake to win winAmount.  LAY: risk winAmount (liability) to win the stake.
    liability: s === SIDE.BACK ? stake : winAmount,
    potentialProfit: s === SIDE.BACK ? winAmount : stake,
  });
}

/** Profit/loss of one bet if `winner` is the winning selection. */
function oddsBetPL(bet, winner) {
  const s = typeof bet.side === 'string' ? bet.side.toUpperCase() : bet.side;
  const selectionWon = String(bet.selection).trim().toLowerCase() === String(winner).trim().toLowerCase();
  if (s === SIDE.BACK) return selectionWon ? bet.potentialProfit : -bet.stake;
  return selectionWon ? -bet.liability : bet.stake;
}

/**
 * Market book: net P/L for every possible winner, plus exposure.
 * outcomes = all selection ids, e.g. ['GRB','ECL'] or ['0','1',...,'9'].
 * Show each outcome's pl under its runner/tile; exposure is the 'L:' figure for the market.
 * commissionBps: e.g. 200 = 2% on net profit only.
 */
function oddsBook(bets, outcomes, { commissionBps = 0 } = {}) {
  const pl = {};
  for (const out of outcomes) {
    let net = 0;
    for (const b of bets) net += oddsBetPL(b, out);
    pl[out] = commissionBps > 0 && net > 0 ? net - roundDiv(net * commissionBps, 10000) : net;
  }
  const worst = Math.min(0, ...Object.values(pl));
  return { pl, exposure: 0 - worst };
}

/** What the book would look like if `newBet` were added (bet-slip preview). */
function previewOdds(bets, newBet, outcomes, opts) {
  const before = oddsBook(bets, outcomes, opts);
  const after = oddsBook([...bets, newBet], outcomes, opts);
  return { before, after, exposureChange: after.exposure - before.exposure };
}

/* ---------- Fancy / session (line + rate) ---------- */

function fancyBet({ side, line, rate, stake }) {
  const s = typeof side === 'string' ? side.toUpperCase() : side;
  if (s !== FANCY.YES && s !== FANCY.NO) throw new RangeError('side must be YES or NO');
  if (!Number.isInteger(line) || line < 0) throw new RangeError('line must be a whole number >= 0');
  assertInt(rate, 'rate');
  assertInt(stake, 'stake');
  const rateAmount = roundDiv(stake * rate, 100);
  return Object.freeze({
    side: s, line, rate, stake,
    liability: s === FANCY.YES ? stake : rateAmount,
    potentialProfit: s === FANCY.YES ? rateAmount : stake,
  });
}

/** Yes wins when total >= line; No wins when total < line. */
function fancyBetPL(bet, total) {
  const s = typeof bet.side === 'string' ? bet.side.toUpperCase() : bet.side;
  const yesWins = total >= bet.line;
  if (s === FANCY.YES) return yesWins ? bet.potentialProfit : -bet.stake;
  return yesWins ? -bet.liability : bet.stake;
}

/** Ladder of net P/L for each run total from minRuns..maxRuns (the 'Book' view). */
function fancyBook(bets, minRuns, maxRuns) {
  const ladder = [];
  let worst = 0;
  for (let t = minRuns; t <= maxRuns; t++) {
    let net = 0;
    for (const b of bets) net += fancyBetPL(b, t);
    ladder.push({ total: t, pl: net });
    if (net < worst) worst = net;
  }
  return { ladder, exposure: 0 - worst };
}

/* ---------- Account header (B: and L:) ---------- */

/**
 * equity    = total account value in units (does not change until a market settles).
 * exposures = one non-negative exposure per market that has open bets (book.exposure).
 * Returns what the header shows: balance 'B' (available) and liability 'L' (shown NEGATIVE).
 * Verified against screenshots: equity 4,460 -> lay 2,000 @2.02 -> B 2,420 / L -2,040
 *                                              -> back 2,000 @5.1 -> B 420 / L -4,040.
 */
function accountSummary(equity, exposures) {
  if (!Number.isInteger(equity)) throw new RangeError('equity must be an integer');
  const total = exposures.reduce((a, b) => a + b, 0);
  return { balance: equity - total, liability: 0 - total };
}

/* ---------- Display helpers (match the reference screens) ---------- */

/** 1400 -> "1,400", -2040 -> "-2,040" (plain hyphen-minus, thousands separators). */
function formatUnits(n) {
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Available size under a price: 720 -> "720", 1200 -> "1.2K", 378200 -> "378.2K", 14000000 -> "14.0M". */
function formatCompact(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) {
    const k = (n / 1e3).toFixed(1);
    if (k !== '1000.0') return k + 'K';
  }
  return (n / 1e6).toFixed(1) + 'M';
}

/** Bet-slip 'Profit' cell: "<profit if it wins> / <loss if it loses>", e.g. "1,400 / -2,000". */
function slipProfitText(bet) {
  return `${formatUnits(bet.potentialProfit)} / ${formatUnits(0 - bet.liability)}`;
}

module.exports = {
  SIDE,
  FANCY,
  assertInt,
  oddsX100,
  roundDiv,
  oddsBet,
  oddsBetPL,
  oddsBook,
  previewOdds,
  fancyBet,
  fancyBetPL,
  fancyBook,
  accountSummary,
  formatUnits,
  formatCompact,
  slipProfitText
};
