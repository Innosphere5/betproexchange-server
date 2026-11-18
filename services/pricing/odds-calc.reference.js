// odds-calc.reference.js — reference implementation of the odds calculation (pure JS, ESM, no deps).
// ALL numeric parameters in FORMATS / BASE / WKT_SCALE are PLACEHOLDERS until calibrated from historical
// ball-by-ball data (section 6 of ODDS_CALCULATION_CONTEXT.md). Structure and maths are final; numbers are not.

// ---------- helpers ----------
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const dec = (step) => (String(step).split('.')[1] || '').length;
export const floorTo = (x, step) => +(Math.floor(x / step + 1e-9) * step).toFixed(dec(step));
export const ceilTo = (x, step) => +(Math.ceil(x / step - 1e-9) * step).toFixed(dec(step));
export const roundTo = (x, step) => +(Math.round(x / step) * step).toFixed(dec(step));
export const rateToProb = (rate) => 100 / (100 + rate);            // user's profit rate per 100 staked -> implied chance
export const rateToDecimal = (rate) => 1 + rate / 100;

export const rng = (seed) => { // mulberry32
  let s = seed | 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

// ---------- 1. ball-outcome model (PLACEHOLDER parameters) ----------
export const FORMATS = {
  T20:  { maxBalls: 120,  pseudoBalls: 36,  phases: [{ from: 0, rpo: 7.4, wkt: 0.045 }, { from: 36, rpo: 7.2, wkt: 0.050 }, { from: 96, rpo: 9.6, wkt: 0.070 }] },
  ODI:  { maxBalls: 300,  pseudoBalls: 60,  phases: [{ from: 0, rpo: 5.2, wkt: 0.020 }, { from: 60, rpo: 5.0, wkt: 0.024 }, { from: 240, rpo: 7.8, wkt: 0.045 }] },
  TEST: { maxBalls: Infinity, pseudoBalls: 120, phases: [{ from: 0, rpo: 3.0, wkt: 0.017 }] },
};
const WKT_SCALE = [1.0, 0.98, 0.95, 0.90, 0.86, 0.80, 0.74, 0.66, 0.55, 0.45];   // scoring multiplier by wickets lost
const BASE = { 1: 0.34, 2: 0.06, 3: 0.005, 4: 0.10, 6: 0.045 };                // relative shape of scoring outcomes
const EXTRAS = 0.03;                                                             // wide+no-ball share of deliveries

export const phaseOf = (fmt, balls) => { let i = 0; for (let k = 0; k < fmt.phases.length; k++) if (balls >= fmt.phases[k].from) i = k; return i; };

/** Per-delivery outcome table whose expected runs per LEGAL ball equals rpo/6 and wicket prob per legal ball equals wkt. */
export function ballTable(rpo, wktPerLegal, ext = EXTRAS) {
  const sumB = Object.values(BASE).reduce((a, v) => a + v, 0);
  const sumKB = Object.entries(BASE).reduce((a, [k, v]) => a + +k * v, 0);
  const mu = rpo / 6;
  let s = (mu * (1 - ext) - ext) / sumKB;                      // exact solve: runs/legal = (s*sumKB + ext)/(1-ext)
  const wD = wktPerLegal * (1 - ext);                          // wicket prob per delivery
  s = clamp(s, 0, (1 - wD - ext) / sumB);                      // keep P(dot) >= 0
  const p = { dot: 1 - wD - ext - s * sumB, W: wD, wd: ext * 0.8, nb: ext * 0.2 };
  for (const k of Object.keys(BASE)) p[k] = s * BASE[k];
  const outs = Object.keys(p), cum = []; let c = 0;
  for (const o of outs) { c += p[o]; cum.push(c); } cum[cum.length - 1] = 1;
  return { p, outs, cum };
}
export function expectedRunsPerLegal(t) {                     // analytic check used by tests
  const legal = 1 - t.p.wd - t.p.nb;
  const bat = [1, 2, 3, 4, 6].reduce((a, k) => a + k * t.p[k], 0);
  return (bat + t.p.wd + t.p.nb) / legal;
}

// ---------- 2. live blending ----------
export function avgPriorRpo(fmt, balls) {
  let sum = 0; for (let b = 0; b < balls; b++) sum += fmt.phases[phaseOf(fmt, b)].rpo; return balls ? sum / balls : 0;
}
/** Scales the prior scoring rate toward what this innings has actually done (Bayesian pseudo-balls). */
export function liveLambda(fmt, st) {
  const n = st.legalBalls; if (n <= 0) return 1;
  const obs = (st.runs * 6) / n, prior = avgPriorRpo(fmt, n), n0 = fmt.pseudoBalls;
  return clamp(((n0 * prior + n * obs) / (n0 + n)) / prior, 0.6, 1.6);
}

// ---------- 3. simulation ----------
/**
 * spec: {kind:'runsAtOver', overN} | {kind:'runsInOver', overN} | {kind:'runsAtWicket', n}
 * st: {runs, wickets, legalBalls, target|null, windowStartRuns?}
 * returns {samples:Uint16Array, pEarlyEnd}
 */
export function simulate(st, fmt, spec, { nSims = 20000, seed = 1, lambda = liveLambda(fmt, st) } = {}) {
  const r = rng(seed), cache = [];
  const table = (b, w) => {
    const pi = phaseOf(fmt, b), key = (pi << 4) | w;
    let t = cache[key];
    if (!t) {
      const ph = fmt.phases[pi];
      t = ballTable(ph.rpo * WKT_SCALE[Math.min(w, 9)] * lambda, ph.wkt);
      cache[key] = t;
    }
    return t;
  };
  const goal = spec.kind === 'runsAtWicket' ? Infinity : spec.overN * 6;
  const start = spec.kind === 'runsInOver' ? (spec.overN - 1) * 6 : 0;
  if (spec.kind === 'runsInOver' && st.legalBalls > start && st.windowStartRuns === undefined) throw new Error('windowStartRuns required');
  if (spec.kind === 'runsAtWicket' && st.wickets >= spec.n) throw new Error('wicket already fallen');
  const out = new Uint16Array(nSims); let early = 0, k = 0;
  for (let i = 0; i < nSims; i++) {
    let runs = st.runs, w = st.wickets, b = st.legalBalls, free = false, done = false, atStart = st.legalBalls === start ? st.runs : (st.windowStartRuns ?? null);
    while (true) {
      if (spec.kind !== 'runsAtWicket' && b >= goal) break;
      if (b >= fmt.maxBalls) { done = true; break; }
      if (spec.kind === 'runsInOver' && b === start && atStart === null) atStart = runs;
      const t = table(b, w), u = r(); let j = 0; while (t.cum[j] < u) j++;
      const o = t.outs[j], wasFree = free; free = false;
      if (o === 'wd') { runs += 1; continue; }
      if (o === 'nb') { runs += 1; free = true; continue; }
      b++;
      if (o === 'W') { if (!wasFree) w++; } else if (o !== 'dot') runs += +o;
      if (spec.kind === 'runsAtWicket' && w >= spec.n) { out[k++] = runs; break; }
      if (w >= 10 || (st.target !== null && runs >= st.target)) { done = true; break; }
    }
    if (done) { early++; continue; }
    if (spec.kind === 'runsInOver') out[k++] = runs - (atStart ?? st.runs);
    else if (spec.kind === 'runsAtOver') out[k++] = runs;
  }
  return { samples: out.subarray(0, k), pEarlyEnd: early / nSims };
}

// ---------- 4. distribution summary ----------
export function distStats(samples) {
  const n = samples.length; if (!n) return null;
  let max = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (s > max) max = s;
    sum += s;
  }
  const counts = new Uint32Array(max + 2);
  for (let i = 0; i < n; i++) counts[samples[i]]++;
  const prefix = new Uint32Array(max + 3);
  for (let i = 0; i <= max + 1; i++) prefix[i + 1] = prefix[i] + counts[i];
  const pLess = (L) => (L <= 0 ? 0 : L >= prefix.length ? 1 : prefix[L] / n);
  let odd = 0; const digit = new Array(10).fill(0);
  for (let x = 0; x <= max; x++) { if (x % 2) odd += counts[x]; digit[x % 10] += counts[x]; }
  const quantile = (q) => { let c = 0; for (let x = 0; x <= max; x++) { c += counts[x]; if (c / n >= q) return x; } return max; };
  return { n, max, pLess, pAtLeast: (L) => 1 - pLess(L), pOdd: odd / n, pEven: 1 - odd / n, pDigit: digit.map((c) => c / n), quantile,
           mean: sum / n };
}

// ---------- 5. quote builders ----------
export const DEFAULTS = { fancyMargin: 0.02, evenOddMargin: 0.01, lastFigureMargin: 0.115, pFloor: 0.002, oddsMaxEO: 3.0, oddsMaxLF: 20,
  rateStep: 5, rateMin: 70, rateMax: 130, rateRounding: 'floor', latencyMarginPerBall: 0.005 };
export const effMargin = (m, unseenBalls, cfg = DEFAULTS) => m + cfg.latencyMarginPerBall * unseenBalls;   // heuristic, tune by adversarial backtest

/** Fancy 2, spread mode: Yes/No lines differ, rates 100/100 (e.g. 20/19). */
export function fancySpread(stats, { margin = DEFAULTS.fancyMargin, bufferRuns = 0 } = {}) {
  const h = margin, lim = 0.5 - h; let yes = 0, no = 0;
  for (let L = 0; L <= stats.max + 1; L++) { if (stats.pAtLeast(L) <= lim) { yes = L; break; } yes = L; }
  for (let L = 0; L <= stats.max + 1; L++) { if (stats.pLess(L) <= lim) no = L; else break; }
  yes += Math.ceil(bufferRuns / 2); no = Math.max(no - Math.floor(bufferRuns / 2), 0);
  return { mode: 'spread', yesLine: yes, noLine: no, rateYes: 100, rateNo: 100, gapProb: stats.pLess(yes) - stats.pLess(no) };
}

/** Profit rates for a same-line Yes/No quote at line L (e.g. 28/28 at 90/110). Edge m is charged on each side. */
export function rateForLine(stats, L, { margin = DEFAULTS.fancyMargin, step = DEFAULTS.rateStep, rounding = DEFAULTS.rateRounding } = {}) {
  const p = stats.pAtLeast(L), q = 1 - p;
  const yes = 100 * ((q - margin) / p), no = 100 * ((p - margin) / q);
  const rd = rounding === 'nearest' ? roundTo : floorTo;
  return { p, rateYes: rd(yes, step), rateNo: rd(no, step), rawYes: yes, rawNo: no };
}
/** Fancy 2, same-line mode: choose the integer line whose rates stay inside [rateMin, rateMax], closest to p = 0.5. */
export function fancySameLine(stats, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg }; let best = null;
  for (let L = 1; L <= stats.max; L++) {
    const x = rateForLine(stats, L, { margin: c.fancyMargin, step: c.rateStep, rounding: c.rateRounding });
    if (!(x.p > 0 && x.p < 1)) continue;
    if ([x.rawYes, x.rawNo].some((v) => v < c.rateMin || v > c.rateMax)) continue;
    const d = Math.abs(x.p - 0.5); if (!best || d < best.d) best = { d, L, ...x };
  }
  return best && { mode: 'sameLine', line: best.L, rateYes: best.rateYes, rateNo: best.rateNo, pYes: best.p };
}

/** Moves rates toward the lighter side. exposureYes/No = current worst-case liability on each side. */
export function skewRates(rateYes, rateNo, exposureYes, exposureNo, limit, { maxSkew = 10, step = DEFAULTS.rateStep } = {}) {
  const s = clamp(((exposureYes - exposureNo) / limit) * maxSkew, -maxSkew, maxSkew);
  return { rateYes: floorTo(rateYes - s, step), rateNo: floorTo(rateNo + s, step), skew: s };
}

export function evenOdd(stats, { margin = DEFAULTS.evenOddMargin, oddsMax = DEFAULTS.oddsMaxEO } = {}) {
  const side = (p) => { const back = floorTo(clamp((1 - margin) / p, 1.01, oddsMax), 0.01), lay = ceilTo(clamp((1 + margin) / p, 1.01, oddsMax), 0.01);
    return { back, lay, rateBack: Math.round((back - 1) * 100), rateLay: Math.round((lay - 1) * 100) }; };
  return { odd: side(stats.pOdd), even: side(stats.pEven) };
}

export function lastFigure(stats, { margin = DEFAULTS.lastFigureMargin, pFloor = DEFAULTS.pFloor, oddsMax = DEFAULTS.oddsMaxLF } = {}) {
  const odds = stats.pDigit.map((p) => Math.max(1.01, floorTo(Math.min((1 - margin) / Math.max(p, pFloor), oddsMax), 0.05)));
  return { odds, overround: odds.reduce((a, o) => a + 1 / o, 0) };
}
export const lastFigureFixed = (odds = 8.85) => ({ odds: Array(10).fill(odds), overround: 10 / odds });

/** Line ladder: `under` levels (user wins if X < level) and `over` levels (user wins if X >= level), 3 each, one run apart. */
export function lineLadder(stats, { margin = DEFAULTS.fancyMargin, levels = 3, bufferRuns = 0 } = {}) {
  const f = fancySpread(stats, { margin, bufferRuns });
  return { under: Array.from({ length: levels }, (_, i) => f.noLine - i), over: Array.from({ length: levels }, (_, i) => f.yesLine + i) };
}

// ---------- 6. accuracy metrics ----------
export const brier = (preds, outcomes) => preds.reduce((a, p, i) => a + (p - outcomes[i]) ** 2, 0) / preds.length;
export function reliability(preds, outcomes, bins = 10) {
  const b = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  preds.forEach((p, i) => { const k = Math.min(bins - 1, Math.floor(p * bins)); b[k].n++; b[k].p += p; b[k].y += outcomes[i]; });
  return b.map((x, i) => ({ bin: i, n: x.n, predicted: x.n ? x.p / x.n : null, observed: x.n ? x.y / x.n : null }));
}
