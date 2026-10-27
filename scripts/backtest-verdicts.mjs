#!/usr/bin/env node
/**
 * Verdict Backtester — measures how the AI Verdict's quant core would have
 * performed historically. This is the trust anchor: "BUY-rated signals from
 * this engine returned X% over the window (cash-relative expectation first);
 * SPY-relative alpha over the same windows is reported as a secondary figure."
 *
 * Reporting convention (2026-10-27 research recommendation, see
 * tmp/entry-timing-summary.md): the PRIMARY metric is the expected absolute
 * forward return — alpha vs cash with a ~0 risk-free proxy over 90d windows,
 * i.e. the raw forward return. The SPY-relative figure is kept as a secondary
 * benchmark view and labeled as such everywhere (report JSON + console).
 *
 * Method (honest by construction):
 *  - Walks monthly checkpoints over the last N years for a shared universe of
 *    tickers. Pass 1 fetches every ticker's candles + EDGAR facts once; pass 2
 *    walks the checkpoints CROSS-SECTIONALLY so scores can use cross-sectional
 *    (sector) percentile ranks exactly like the live engine's composition.
 *  - At each checkpoint, feeds ONLY data available up to that date into the
 *    quant core (candles slice + fundamentals from the latest 10-K FILED
 *    before the checkpoint — no look-ahead; gated on the filing date, not the
 *    fiscal period end).
 *  - Sector percentiles per checkpoint are computed within sector_label
 *    (GICS) when a sector has >= 5 names with the factor, else across the
 *    whole test universe (>= 10 names), else the factor drops out of the
 *    composite (weights renormalize over present factors).
 *  - News/LLM are excluded from scoring (no historical news feed) — this makes
 *    results a lower-bound, not a fantasy.
 *  - Forward return = price change over the next `horizonDays` (default 90),
 *    evaluated per horizon at 5d, 21d AND the CLI horizon (each printed).
 *  - Transaction costs: LIQUIDITY-SCALED square-root impact (see COST_MODEL)
 *    — small orders in thin names cost more; flat 10 bps only as a fallback
 *    when volume/sigma data is missing.
 *  - Significance: bootstrap 95% CIs on TICKER-level means (1000 draws,
 *    deterministic seed) so overlapping forward windows can't fake edge —
 *    reported for BOTH the cash-relative (raw forward return) primary metric
 *    and the SPY-relative alpha.
 *  - Rank performance (P123-style quantile test): at each checkpoint the
 *    scored universe is bucketed into score QUINTILES; mean forward return
 *    and alpha per bucket; Spearman (and Pearson) of bucket-vs-return per
 *    month; first-half vs second-half consistency; top-vs-middle-bucket
 *    pass/fail — see rankPerformance in the report.
 *  - Benchmark: SPY buy-and-hold over the same windows (secondary view; the
 *    primary reported figure is the absolute forward return vs cash).
 *  - Emits data/calibration.json: score-band -> observed target1 hit-rate
 *    (price reached target1 within the horizon before hitting the stop),
 *    consumed by the quant engine's confidence lookup.
 *  - Also re-scores every checkpoint the LEGACY way (pre-composition behavior:
 *    tiered fundamentals, no sector percentiles, no momentum block) so the
 *    report can print an honest before/after.
 *
 * Usage:  node scripts/backtest-verdicts.mjs [--years=3] [--horizon=90] [--top=150] [--tickers=AAPL,MSFT] [--notional=25000]
 * Output: data/backtest-report.json + console summary
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(process.cwd());
const WAREHOUSE = path.join(ROOT, 'data', 'warehouse.duckdb');
const OUT = path.join(ROOT, 'data', 'backtest-report.json');
const CALIBRATION_OUT = path.join(ROOT, 'data', 'calibration.json');

// ---- transaction costs: liquidity-scaled square-root impact ---------------
// Flat 10 bps/side overstated edge on anything outside the most liquid names.
// Form (published methodology concepts, re-expressed in our own terms):
//   costPctPerSide = K × σ20 × sqrt(participation)
//     σ20          = stdev of the last 20 daily log returns (realized vol)
//     participation = orderNotional / 10-day median daily dollar volume
//     K            = 2.0 impact coefficient
// Small orders in thin names pay far more than mega-caps; the floor keeps a
// minimal friction for ultra-liquid fills, the cap prevents absurd tails.
// Fallback when volume/σ data is missing: flat 10 bps/side (old model).
const IMPACT_K = 2.0;
const COST_FLOOR_BPS_PER_SIDE = 1;
const COST_CAP_BPS_PER_SIDE = 400;
const FLAT_FALLBACK_BPS_PER_SIDE = 10;
const SIGMA_WINDOW = 20; // daily log returns for realized vol
const DV_WINDOW = 10; // days for median dollar volume

// ---- args ----
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const YEARS = Number(getArg('years', 3));
const HORIZON = Number(getArg('horizon', 90)); // forward return window in calendar days
const TOP = Number(getArg('top', 150)); // how many S&P names to test (liquidity-first)
const TICKERS_ARG = getArg('tickers', null);
const NOTIONAL_USD = Number(getArg('notional', 25000)); // reference order size for impact

// ---- per-horizon evaluation (audit fix) ----
// The shipped trade windows are 5 and 21 days, but the report only ever
// printed the `--horizon` window (90d). Every checkpoint is now evaluated at
// 5d, 21d AND the CLI horizon, each printed separately.
const HORIZONS = [...new Set([5, 21, HORIZON])].sort((a, b) => a - b);
const DAY_MS = 24 * 3600 * 1000;

// ---- overlapping-checkpoint robustness (audit fix) ----
// Monthly checkpoints with a 90d forward window overlap heavily, so counting
// every checkpoint as an independent observation fakes significance. We
// bootstrap TICKER-LEVEL means instead: resample tickers with replacement
// 1000× (deterministic seeded PRNG, no dependencies) and report a percentile
// 95% CI for the average alpha per action.
const BOOTSTRAP_DRAWS = 1000;
const BOOTSTRAP_SEED = 42;

// ---- rank performance (quantile monotonicity) test ----
// P123-style: bucket the scored universe into quintiles by verdict score at
// each checkpoint, mean forward return per bucket, Spearman of bucket-vs-
// return, first/second-half consistency, top-vs-middle pass/fail.
const RANK_BUCKETS = 5;
const RANK_MIN_UNIVERSE = 10; // need at least 2 names per bucket

// ---- quant core (kept in lockstep with src/services/quantEngine.ts) ----
const sma = (v, p) => (v.length < p ? undefined : v.slice(-p).reduce((a, b) => a + b, 0) / p);

/** Wilder RSI — aligned with the engine (the old simple-average RSI is kept
 *  below as rsiSimple for the legacy replication only). */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return undefined;
  let avgGain = 0;
  let avgLoss = 0;
  const window = closes.slice(-(period + 1));
  for (let i = 1; i < window.length; i++) {
    const diff = window[i] - window[i - 1];
    if (i === 1) {
      avgGain = Math.max(0, diff);
      avgLoss = Math.max(0, -diff);
      continue;
    }
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Legacy simple-average RSI (pre-Wilder) — kept ONLY for the legacy replication. */
function rsiSimple(closes, period = 14) {
  if (closes.length < period + 1) return undefined;
  let gains = 0, losses = 0;
  const w = closes.slice(-(period + 1));
  for (let i = 1; i < w.length; i++) {
    const d = w[i] - w[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

function classifyTrend(price, s50, s200) {
  if (s50 && s200) {
    if (price > s50 && s50 > s200) return 'up';
    if (price < s50 && s50 < s200) return 'down';
  }
  return 'sideways';
}

// ---- percentile composition (mirror of quantEngine.mjs v2 — keep in lockstep)
/** Midpoint percentile rank of x within a sorted array (0-100); needs >= 5 peers. */
function percentileRank(sortedValues, x) {
  if (!Array.isArray(sortedValues) || sortedValues.length < 5) return undefined;
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  let below = 0;
  let equal = 0;
  for (const v of sortedValues) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return Math.round(((below + 0.5 * equal) / sortedValues.length) * 100);
}

const FUNDAMENTAL_FACTORS = [
  { key: 'growth', weight: 12, direction: 1, raw: 'revenueGrowthYoY' },
  { key: 'margin', weight: 9, direction: 1, raw: 'netMargin' },
  { key: 'roe', weight: 8, direction: 1, raw: 'roe' },
  { key: 'pe', weight: 6, direction: -1, raw: 'peRatio' },
];

/** Stretch a weighted average back over [lo, hi] (renormalization guard). */
function renormalize(weightedSum, weightSum, lo = 0, hi = 100) {
  if (!(weightSum > 0)) return undefined;
  const avg = weightedSum / weightSum;
  return hi > lo ? ((avg - lo) / (hi - lo)) * 100 : 50;
}

/** Continuous percentile composition of the fundamentals block (±35 scale). */
function fundamentalsComposite(pct, fundamentals) {
  let weightedSum = 0;
  let weightSum = 0;
  for (const f of FUNDAMENTAL_FACTORS) {
    const raw = fundamentals ? fundamentals[f.raw] : undefined;
    const pctile = pct ? pct[f.key] : undefined;
    if (raw === undefined || !Number.isFinite(raw) || pctile === undefined) continue;
    weightedSum += f.weight * (f.direction > 0 ? pctile : 100 - pctile);
    weightSum += f.weight;
  }
  if (!(weightSum > 0)) return undefined;
  const composite = renormalize(weightedSum, weightSum) ?? 50;
  return Math.max(-35, Math.min(35, ((composite - 50) / 50) * 35));
}

/** 12-1 momentum (skip-1m): close[t−21] / close[t−252] − 1; needs ≥ 253 closes. */
function momentum121(closes) {
  if (!Array.isArray(closes) || closes.length < 253) return undefined;
  const past = closes[closes.length - 253];
  const prev = closes[closes.length - 22];
  if (!(past > 0) || !(prev > 0)) return undefined;
  return prev / past - 1;
}
const MOMENTUM_BLOCK_MAX = 10;

// ---- Factor block weights (v3 — grid-searched; mirrors quantEngine.mjs/.ts) --
// Adopted from scripts/weight-search.mjs (data/weight-search.json,
// cluster-robust gate): trend 0 / RSI 5 / fundamentals 0 / momentum 20 /
// sentiment 25, block points scaled by w/cap and the total renormalized to
// the shipped 110-point scale so the ±100 clamp and the BUY>=35 / HOLD / SELL
// thresholds keep their meaning.
const FACTOR_WEIGHTS = { trend: 0, rsi: 5, fund: 0, mom: 20, sent: 25 };
const FACTOR_CAPS = { trend: 25, rsi: 15, fund: 35, mom: 10, sent: 25 };
const WEIGHT_SCALE = 110 / (FACTOR_WEIGHTS.trend + FACTOR_WEIGHTS.rsi + FACTOR_WEIGHTS.fund + FACTOR_WEIGHTS.mom + FACTOR_WEIGHTS.sent);
const BLOCK_MULT = {
  trend: (FACTOR_WEIGHTS.trend / FACTOR_CAPS.trend) * WEIGHT_SCALE,
  rsi: (FACTOR_WEIGHTS.rsi / FACTOR_CAPS.rsi) * WEIGHT_SCALE,
  fund: (FACTOR_WEIGHTS.fund / FACTOR_CAPS.fund) * WEIGHT_SCALE,
  mom: (FACTOR_WEIGHTS.mom / FACTOR_CAPS.mom) * WEIGHT_SCALE,
  sent: (FACTOR_WEIGHTS.sent / FACTOR_CAPS.sent) * WEIGHT_SCALE,
};

/**
 * Quant-core mirror (current engine v3 weights): block points are scaled by
 * FACTOR_WEIGHTS/FACTOR_CAPS and the total renormalized to the 110 scale
 * (trend 10 / RSI 15 / sentiment 25 clamped /4 / fundamentals 0 — excluded by
 * the weight search — / momentum 10), BUY >= 35, SELL needs 2 bearish votes.
 * Must match services/verdict/quantEngine.mjs scoreVerdict.
 */
function scoreVerdict({ price, candles, fundamentals, sentimentScore = 0, sectorPercentiles }) {
  const pct = sectorPercentiles || {};
  const closes = candles.map((c) => c.close);
  const trend = classifyTrend(price, sma(closes, 50), sma(closes, 200));
  const rv = rsi(closes, 14);

  let score = 0;
  if (trend === 'up') score += 25 * BLOCK_MULT.trend;
  else if (trend === 'down') score -= 25 * BLOCK_MULT.trend;
  if (rv !== undefined) {
    if (rv < 30) score += 15 * BLOCK_MULT.rsi;
    else if (rv < 45) score += 7 * BLOCK_MULT.rsi;
    else if (rv > 70) score -= 15 * BLOCK_MULT.rsi;
    else if (rv > 55) score -= 7 * BLOCK_MULT.rsi;
  }
  score += Math.max(-25, Math.min(25, sentimentScore / 4)) * BLOCK_MULT.sent;
  if (fundamentals) {
    const comp = fundamentalsComposite(pct, fundamentals);
    if (comp !== undefined) {
      score += comp * BLOCK_MULT.fund;
    } else {
      // Absolute-threshold fallback (no cross-sectional support available).
      let f = 0;
      if (fundamentals.revenueGrowthYoY !== undefined) f += fundamentals.revenueGrowthYoY > 10 ? 12 : fundamentals.revenueGrowthYoY > 0 ? 6 : fundamentals.revenueGrowthYoY > -10 ? -6 : -12;
      if (fundamentals.netMargin !== undefined) f += fundamentals.netMargin > 20 ? 9 : fundamentals.netMargin > 5 ? 5 : fundamentals.netMargin > 0 ? 0 : -9;
      if (fundamentals.roe !== undefined) f += fundamentals.roe > 20 ? 8 : fundamentals.roe > 10 ? 4 : fundamentals.roe > 0 ? 0 : -8;
      if (fundamentals.peRatio !== undefined) f += fundamentals.peRatio > 0 && fundamentals.peRatio < 25 ? 6 : fundamentals.peRatio >= 25 && fundamentals.peRatio <= 60 ? 0 : -6;
      score += Math.max(-35, Math.min(35, f)) * BLOCK_MULT.fund;
    }
  }
  const m121 = momentum121(closes);
  if (m121 !== undefined) score += Math.max(-MOMENTUM_BLOCK_MAX, Math.min(MOMENTUM_BLOCK_MAX, m121 * 50)) * BLOCK_MULT.mom;

  score = Math.round(Math.max(-100, Math.min(100, score)));
  let action;
  if (score >= 35) action = 'BUY';
  else if (score >= 15) action = 'HOLD';
  else if (score > -15) action = 'HOLD';
  else {
    // SELL requires confirmation: a bare low score is frequently a temporary
    // dip in a structurally sound company (value traps). Demand at least TWO
    // independent bearish confirmations from {trend, fundamentals, momentum}.
    let bearishVotes = 0;
    if (trend === 'down') bearishVotes++;
    if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) bearishVotes++;
    if (rv !== undefined && rv > 70) bearishVotes++; // momentum exhaustion
    action = bearishVotes >= 2 ? 'SELL' : 'HOLD';
  }
  return { score, action };
}

/**
 * LEGACY replication (pre-composition behavior): tiered fundamentals from
 * absolute thresholds, no sector percentiles, no momentum block, simple RSI.
 * Preserved verbatim so the before/after comparison stays honest.
 */
function legacyScoreVerdict({ price, candles, fundamentals, sentimentScore = 0 }) {
  const closes = candles.map((c) => c.close);
  const trend = classifyTrend(price, sma(closes, 50), sma(closes, 200));
  const rv = rsiSimple(closes, 14);

  let score = 0;
  if (trend === 'up') score += 25;
  else if (trend === 'down') score -= 25;
  if (rv !== undefined) {
    if (rv < 30) score += 15;
    else if (rv < 45) score += 7;
    else if (rv > 70) score -= 15;
    else if (rv > 55) score -= 7;
  }
  score += Math.max(-25, Math.min(25, sentimentScore / 4));
  if (fundamentals) {
    let f = 0;
    if (fundamentals.revenueGrowthYoY !== undefined) f += fundamentals.revenueGrowthYoY > 10 ? 12 : fundamentals.revenueGrowthYoY > 0 ? 6 : fundamentals.revenueGrowthYoY > -10 ? -6 : -12;
    if (fundamentals.netMargin !== undefined) f += fundamentals.netMargin > 20 ? 9 : fundamentals.netMargin > 5 ? 5 : fundamentals.netMargin > 0 ? 0 : -9;
    if (fundamentals.roe !== undefined) f += fundamentals.roe > 20 ? 8 : fundamentals.roe > 10 ? 4 : fundamentals.roe > 0 ? 0 : -8;
    if (fundamentals.peRatio !== undefined) f += fundamentals.peRatio > 0 && fundamentals.peRatio < 25 ? 6 : fundamentals.peRatio >= 25 && fundamentals.peRatio <= 60 ? 0 : -6;
    score += Math.max(-35, Math.min(35, f));
  }
  score = Math.round(Math.max(-100, Math.min(100, score)));
  let action;
  if (score >= 35) action = 'BUY';
  else if (score >= 15) action = 'HOLD';
  else if (score > -15) action = 'HOLD';
  else {
    let bearishVotes = 0;
    if (trend === 'down') bearishVotes++;
    if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) bearishVotes++;
    if (rv !== undefined && rv > 70) bearishVotes++;
    action = bearishVotes >= 2 ? 'SELL' : 'HOLD';
  }
  return { score, action };
}

/** Deterministic PRNG (mulberry32) — reproducible bootstrap, zero deps. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap 95% percentile CI for the mean of `values` (ticker-level alpha
 * means): resample with replacement BOOTSTRAP_DRAWS times.
 */
function bootstrapCi(values, draws = BOOTSTRAP_DRAWS, seed = BOOTSTRAP_SEED) {
  const n = values.length;
  if (n < 2) return null;
  const rand = mulberry32(seed);
  const means = new Array(draws);
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[(rand() * n) | 0];
    means[d] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(draws * 0.025)], hi: means[Math.ceil(draws * 0.975) - 1] };
}

// ---- levels port (kept in lockstep with services/verdict/levels.mjs) ----
// Only what the calibration path-simulation needs: ATR-14, fractal pivots and
// the stop/target1 geometry, so backtest calibration measures the SAME target
// structure the live trade plan uses.
function atr14(candles) {
  if (candles.length < 15) return undefined;
  let sum = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / 14;
}

function structureLevels(candles, direction) {
  // Mirrors levels.mjs getStopLossAndTargets (window-5 fractal pivots).
  if (!candles || !candles.length) return null;
  const a = atr14(candles);
  if (!a) return null;
  const price = candles[candles.length - 1].close;
  const w = 5;
  const highs = [];
  const lows = [];
  for (let i = w; i < candles.length - w; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  const resistances = [...highs, ...candles.map((c) => c.high)].filter((v) => v > price).sort((x, y) => x - y);
  const supports = [...lows, ...candles.map((c) => c.low)].filter((v) => v < price).sort((x, y) => y - x);
  if (direction === 'BUY') {
    const stop = Math.min(supports[0] ?? price - 2 * a, price - 2 * a);
    const t1 = resistances.length ? Math.min(resistances[0] + a, price + 3 * a) : price + 2 * a;
    return { stop, target1: t1 };
  }
  // SELL (short): stop above, target below — mirrored, same as levels.mjs.
  const stop = Math.max(resistances[0] ?? price + 2 * a, price + 2 * a);
  const t1 = supports.length ? Math.max(supports[0] - a, price - 3 * a) : price - 2 * a;
  return { stop, target1: t1 };
}

/**
 * Walk the forward window and classify the outcome: did price reach target1
 * ('hit') before touching the stop ('stop'), or neither ('none')? Same-bar
 * stop+target ambiguity resolves to 'stop' (conservative).
 */
function pathOutcome(candles, entryIdx, exitIdx, stop, target1, long) {
  for (let i = entryIdx + 1; i <= exitIdx; i++) {
    const c = candles[i];
    if (long) {
      if (c.low <= stop) return 'stop';
      if (c.high >= target1) return 'hit';
    } else {
      if (c.high >= stop) return 'stop';
      if (c.low <= target1) return 'hit';
    }
  }
  return 'none';
}

// ---- score-band buckets (MUST stay in sync with quantEngine confidence lookup) ----
export function calibrationBand(score) {
  if (score >= 35) return '>=35';
  if (score >= 15) return '15..35';
  if (score > -15) return '-15..15';
  if (score >= -35) return '-35..-15';
  return '<-35';
}
const BAND_ORDER = ['<-35', '-35..-15', '-15..15', '15..35', '>=35'];

// ---- liquidity-scaled cost model ------------------------------------------
/**
 * Per-side cost as a fraction (e.g. 0.0012 = 12 bps) for an order placed at
 * candles[idx]:
 *   costPct = K × σ20 × sqrt(notional / medianDollarVolume10d)
 * Fallback (missing σ/volume): flat FLAT_FALLBACK_BPS_PER_SIDE.
 */
function tradeCostPctPerSide(candles, idx, notionalUsd) {
  const fallback = FLAT_FALLBACK_BPS_PER_SIDE / 10000;
  const closeWin = candles.slice(Math.max(0, idx - SIGMA_WINDOW), idx + 1);
  const dvWin = candles.slice(Math.max(0, idx - (DV_WINDOW - 1)), idx + 1);
  if (closeWin.length < SIGMA_WINDOW + 1 || dvWin.length < DV_WINDOW) return { pct: fallback, fallback: true };
  const rets = [];
  for (let i = 1; i < closeWin.length; i++) {
    if (closeWin[i - 1].close > 0) rets.push(Math.log(closeWin[i].close / closeWin[i - 1].close));
  }
  if (rets.length < SIGMA_WINDOW) return { pct: fallback, fallback: true };
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  const sigma = Math.sqrt(variance);
  const dvs = dvWin.map((c) => c.close * (c.volume || 0)).filter((v) => Number.isFinite(v) && v > 0);
  if (dvs.length < Math.ceil(DV_WINDOW / 2)) return { pct: fallback, fallback: true };
  dvs.sort((a, b) => a - b);
  const medianDv = dvs[Math.floor(dvs.length / 2)];
  if (!(medianDv > 0) || !(sigma > 0)) return { pct: fallback, fallback: true };
  const participation = notionalUsd / medianDv;
  let pct = IMPACT_K * sigma * Math.sqrt(participation);
  pct = Math.min(COST_CAP_BPS_PER_SIDE / 10000, Math.max(COST_FLOOR_BPS_PER_SIDE / 10000, pct));
  return { pct, fallback: false };
}

// ---- cross-sectional sector percentiles ------------------------------------
/**
 * For one factor across one checkpoint's snapshot: percentile of each name's
 * value WITHIN its sector (needs >= 5 sector peers with data), else across
 * the whole checkpoint universe (needs >= 10), else undefined (factor drops
 * out of the composite — weights renormalize over present factors).
 * Returns { pct: Map ticker -> percentile|undefined, provenance: {sector, universe, absent} }.
 */
function crossPercentiles(snapshot, valueOf) {
  const bySector = new Map();
  const all = [];
  for (const s of snapshot) {
    const v = valueOf(s);
    if (v === undefined || !Number.isFinite(v)) continue;
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector).push(v);
    all.push(v);
  }
  for (const arr of bySector.values()) arr.sort((a, b) => a - b);
  all.sort((a, b) => a - b);
  const pct = new Map();
  const provenance = { sector: 0, universe: 0, absent: 0 };
  for (const s of snapshot) {
    const v = valueOf(s);
    if (v === undefined || !Number.isFinite(v)) { provenance.absent++; continue; }
    const sectorVals = bySector.get(s.sector) || [];
    if (sectorVals.length >= 5) { pct.set(s.ticker, percentileRank(sectorVals, v)); provenance.sector++; }
    else if (all.length >= 10) { pct.set(s.ticker, percentileRank(all, v)); provenance.universe++; }
    else provenance.absent++;
  }
  return { pct, provenance };
}

// ---- rank performance statistics -------------------------------------------
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null; // zero variance — correlation undefined
  return sxy / Math.sqrt(sxx * syy);
}

/** Average ranks (1-based) with ties sharing the mean of their slots. */
function rankAvg(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function spearman(xs, ys) {
  return pearson(rankAvg(xs), rankAvg(ys));
}

/** Quintile (1=lowest scores … 5=highest scores) for an ascending-sorted list. */
function quintileOf(position, n) {
  const base = Math.floor(n / RANK_BUCKETS);
  const rem = n % RANK_BUCKETS;
  let acc = 0;
  for (let q = 1; q <= RANK_BUCKETS; q++) {
    const size = base + (q <= rem ? 1 : 0);
    if (position < acc + size) return q;
    acc += size;
  }
  return RANK_BUCKETS;
}

// ---- fundamentals as-of a date (EDGAR facts, no look-ahead) ----
/**
 * P0-1 audit fix: facts are gated on the FILING date (`filed_at`), not the
 * fiscal period end. A 10-K for FY2024 can be filed up to ~3 months after the
 * fiscal year ends, so period-end gating leaks information the market could
 * not have had.
 *
 * Fallback approximation for legacy rows (ingested before filed_at existed,
 * filed_at IS NULL): exclude facts whose fiscal period ended less than 45 days
 * before asOf — 10-K/10-Q legal filing windows make it impossible for those
 * numbers to have been public yet. This is strictly more conservative than
 * period-end gating and only applies to legacy rows.
 */
function buildFundamentalsAsOf(facts, asOfMs) {
  const visible = (f) => {
    if (f.filedAt != null) return f.filedAt <= asOfMs;
    // Conservative approximation for legacy rows without a filing date.
    return f.end + 45 * 24 * 3600 * 1000 <= asOfMs;
  };
  // facts: [{tag, end(ms), filedAt(ms|null), val}] pre-filtered to annual 10-K us-gaap rows
  const pick = (tags) => {
    for (const tag of tags) {
      const rows = facts.filter((f) => f.tag === tag && visible(f));
      if (rows.length) {
        rows.sort((a, b) => b.end - a.end);
        return rows[0].val;
      }
    }
    return undefined;
  };
  const revenueTags = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'];
  const revenue = pick(revenueTags);
  const revenuePrev = (() => {
    for (const tag of revenueTags) {
      const rows = facts.filter((f) => f.tag === tag && visible(f)).sort((a, b) => b.end - a.end);
      if (rows.length >= 2) return rows[1].val;
    }
    return undefined;
  })();
  const netIncome = pick(['NetIncomeLoss']);
  const equity = pick(['StockholdersEquity']);
  const eps = pick(['EarningsPerShareDiluted']);

  const out = {};
  if (revenue && revenuePrev && revenuePrev !== 0) out.revenueGrowthYoY = ((revenue - revenuePrev) / Math.abs(revenuePrev)) * 100;
  if (revenue && netIncome) out.netMargin = (netIncome / revenue) * 100;
  if (netIncome && equity && equity > 0) out.roe = (netIncome / equity) * 100;
  if (eps) out.epsDiluted = eps; // caller turns this into peRatio at the checkpoint price
  // NOTE: peRatio is intentionally NOT set here. The caller computes it from
  // the checkpoint price and as-of EPS (price was observable at the checkpoint,
  // so this is look-ahead-free). The old `out.peRatio = null` placeholder was
  // an active bug: scoreVerdict treats null as a present-but-invalid P/E and
  // docks -6 fundamental points for it.
  return out;
}

// ---- main ----
async function main() {
  if (!fs.existsSync(WAREHOUSE)) {
    console.error('FATAL: warehouse not found — run the EDGAR ingest first.');
    process.exit(1);
  }
  // Copy the warehouse to a scratch file so we never fight the live ingest's
  // write lock; DuckDB file copies of a checkpointed DB are consistent snapshots.
  const snapDir = fs.mkdtempSync(path.join(ROOT, 'data', 'bt-snap-'));
  const snapshot = path.join(snapDir, 'warehouse.duckdb');
  fs.copyFileSync(WAREHOUSE, snapshot);
  const db = await DuckDBInstance.create(snapshot, { access_mode: 'READ_ONLY' });
  const conn = await db.connect();
  const cleanup = () => { try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  // Universe: largest tickers with metrics (market-cap proxy = assets scale isn't
  // available pre-price-merge, so we take companies that have both facts and metrics).
  let tickers;
  if (TICKERS_ARG) {
    tickers = TICKERS_ARG.split(',').map((t) => t.trim().toUpperCase());
  } else {
    const rs = await conn.runAndReadAll(
      `SELECT c.ticker FROM metrics_latest m
       JOIN companies c ON c.cik = m.cik
       WHERE m.revenue IS NOT NULL AND m.net_income IS NOT NULL AND c.ticker IS NOT NULL
       ORDER BY m.revenue DESC LIMIT ${TOP}`
    );
    tickers = rs.getRowObjects().map((r) => String(r.ticker)).filter((t) => t && t !== 'null');
  }
  console.log(`Backtesting ${tickers.length} tickers | ${YEARS}y | ${HORIZON}d forward horizon | notional $${NOTIONAL_USD.toLocaleString()}/order`);

  // Sector labels (GICS) for cross-sectional percentile grouping.
  const sectorMap = new Map();
  const sectorRs = await conn.runAndReadAll(`SELECT ticker, sector_label FROM companies WHERE ticker IS NOT NULL`);
  for (const r of sectorRs.getRowObjects()) sectorMap.set(String(r.ticker), r.sector_label == null ? null : String(r.sector_label));

  // Benchmark: SPY daily closes from Yahoo (stooq fallback). Use yahoo-finance2 via dynamic import.
  const { default: YahooFinance } = await import('yahoo-finance2');
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const startD = new Date();
  startD.setFullYear(startD.getFullYear() - YEARS);

  const spyChart = await yf.chart('SPY', { period1: startD.toISOString().split('T')[0], interval: '1d' });
  const spy = (spyChart.quotes || []).filter((q) => q.close != null).map((q) => ({ t: new Date(q.date).getTime(), c: q.close }));
  console.log(`SPY benchmark: ${spy.length} daily closes`);

  const monthMs = 30.44 * 24 * 3600 * 1000;
  const horizonMs = HORIZON * 24 * 3600 * 1000;
  const checkpointCount = Math.floor((YEARS * 365 - HORIZON) / 30.44); // monthly steps that leave room for the forward window

  // ======================= PASS 1: fetch per-ticker data =======================
  const tickerData = new Map(); // ticker -> {candles, facts, sector}
  let skippedNoData = 0;
  const progressEvery = Math.max(5, Math.floor(tickers.length / 10));
  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    try {
      // One fetch per ticker: (YEARS+1)y daily candles covers the backtest with warmup.
      const p1 = new Date(); p1.setFullYear(p1.getFullYear() - (YEARS + 1));
      const chart = await yf.chart(ticker, { period1: p1.toISOString().split('T')[0], interval: '1d' });
      const candlesAll = (chart.quotes || [])
        .filter((q) => q.close != null && q.open != null && q.high != null && q.low != null)
        .map((q) => ({ time: new Date(q.date).toISOString().split('T')[0], open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume || 0, t: new Date(q.date).getTime() }));
      if (candlesAll.length < 260) { skippedNoData++; continue; }

      // EDGAR facts for this CIK (annual us-gaap rows only).
      // P0-1 fix: the old query filtered `f.fy = 'FY'`, but `fy` stores the
      // fiscal YEAR (e.g. '2025') while `fp` stores 'FY' — it selected ZERO
      // rows, so the backtest ran with no fundamentals at all. Filter on fp,
      // and pull filed_at for look-ahead-free gating.
      const factsRs = await conn.runAndReadAll(
        `SELECT f.tag, f.end, f.val, f.filed_at FROM facts f JOIN companies c ON c.cik = f.cik
         WHERE c.ticker = ? AND f.form = '10-K' AND f.fp = 'FY'`,
        [ticker]
      );
      const facts = factsRs.getRowObjects().map((r) => ({
        tag: String(r.tag),
        end: new Date(String(r.end)).getTime(),
        filedAt: r.filed_at == null ? null : new Date(String(r.filed_at)).getTime(),
        val: Number(r.val),
      }));
      tickerData.set(ticker, { candles: candlesAll, facts, sector: sectorMap.get(ticker) ?? null });
    } catch (err) {
      skippedNoData++;
      if (String(err).includes('429')) console.warn('rate-limited; cooling 30s...');
      await new Promise((r) => setTimeout(r, 350)); // be polite to Yahoo
    }
    if ((ti + 1) % progressEvery === 0) console.log(`[fetch ${ti + 1}/${tickers.length}] ok=${tickerData.size} skipped=${skippedNoData}`);
  }

  // =================== PASS 2: cross-sectional checkpoints ====================
  const mkBuckets = () => ({ BUY: [], SELL: [], HOLD: [] });
  // Per-horizon accumulators: raw forward returns, SPY same-window returns,
  // and net-of-costs variants for traded signals (BUY long / SELL short).
  const byH = new Map();
  for (const h of HORIZONS) byH.set(h, { action: mkBuckets(), spy: mkBuckets(), net: { BUY: [], SELL: [] }, spyNet: { BUY: [], SELL: [] } });
  const primary = byH.get(HORIZON);
  // Ticker-level return samples for the bootstrap: horizon -> action -> ticker -> {fwd[], spy[]}
  const tickerStats = new Map();
  for (const h of HORIZONS) tickerStats.set(h, { BUY: new Map(), SELL: new Map(), HOLD: new Map() });
  // Legacy (pre-composition) replication for the before/after print.
  const legacyBuckets = mkBuckets();
  const legacySpyBuckets = mkBuckets();
  // Score-band calibration accumulators (target1-before-stop hit rates).
  const calib = {};
  for (const b of BAND_ORDER) calib[b] = { n: 0, hits: 0, stopped: 0, neither: 0 };
  // Rank-performance records: one per ticker-checkpoint at the primary horizon.
  const rankRecords = [];
  // Cost observations + cross-sectional percentile provenance counters.
  const costSamples = [];
  let costFallbacks = 0;
  let pctSectorBasis = 0;
  let pctUniverseBasis = 0;
  let pctAbsent = 0;
  let totalSignals = 0;

  const latestT = Math.max(...[...tickerData.values()].map((d) => d.candles[d.candles.length - 1].t));
  const checkpointLogEvery = Math.max(2, Math.floor(checkpointCount / 10));
  let doneCheckpoints = 0;

  for (let k = checkpointCount; k >= 1; k--) {
    const checkpointT = latestT - k * monthMs;
    const monthKey = new Date(checkpointT).toISOString().slice(0, 7);

    // --- snapshot: every ticker with a bar at/after the checkpoint ---
    const snaps = [];
    for (const [ticker, d] of tickerData) {
      const idx = d.candles.findIndex((c) => c.t >= checkpointT);
      if (idx < 0 || idx < 210) continue; // need warmup for SMA200
      const c0 = d.candles[idx];
      const slice = d.candles.slice(0, idx + 1);
      const closes = slice.map((c) => c.close);
      const fundamentals = buildFundamentalsAsOf(d.facts, c0.t);
      // P/E from the checkpoint price and as-of EPS — both were observable at
      // the checkpoint (see buildFundamentalsAsOf note).
      if (fundamentals.epsDiluted && fundamentals.epsDiluted > 0) {
        fundamentals.peRatio = c0.close / fundamentals.epsDiluted;
      }
      snaps.push({ ticker, d, idx, c0, slice, closes, fundamentals, sector: d.sector });
    }
    if (snaps.length < RANK_MIN_UNIVERSE) continue;

    // --- cross-sectional sector percentiles at this checkpoint ---
    const pctResults = {
      growth: crossPercentiles(snaps, (s) => s.fundamentals?.revenueGrowthYoY),
      margin: crossPercentiles(snaps, (s) => s.fundamentals?.netMargin),
      roe: crossPercentiles(snaps, (s) => s.fundamentals?.roe),
      pe: crossPercentiles(snaps, (s) => s.fundamentals?.peRatio),
    };
    for (const { provenance } of Object.values(pctResults)) {
      pctSectorBasis += provenance.sector;
      pctUniverseBasis += provenance.universe;
      pctAbsent += provenance.absent;
    }

    // --- score + evaluate every name at this checkpoint ---
    for (const s of snaps) {
      const sectorPercentiles = {};
      for (const key of Object.keys(pctResults)) {
        const p = pctResults[key].pct.get(s.ticker);
        if (p !== undefined) sectorPercentiles[key] = p;
      }
      const { action, score } = scoreVerdict({ price: s.c0.close, candles: s.slice, fundamentals: s.fundamentals, sectorPercentiles });
      // Legacy replication (pre-composition behavior) for the before/after report.
      const { action: legacyAction } = legacyScoreVerdict({ price: s.c0.close, candles: s.slice });

      // Liquidity-scaled per-side cost for an order placed at this checkpoint.
      const cost = tradeCostPctPerSide(s.d.candles, s.idx, NOTIONAL_USD);
      if (cost.fallback) costFallbacks++; else costSamples.push(cost.pct * 10000);
      const costRtPct = cost.pct * 2; // entry + exit

      // Calibration: same stop/target1 structure as the live trade plan, in
      // the direction the score implies (>=0 long, <0 short) — measured at
      // the PRIMARY horizon (calibration.json feeds the live engine there).
      const pExitIdx = s.d.candles.findIndex((c) => c.t >= s.c0.t + horizonMs);
      if (pExitIdx >= 0) {
        const dir = score >= 0 ? 'BUY' : 'SELL';
        const struct = structureLevels(s.slice, dir);
        if (struct && Number.isFinite(struct.stop) && Number.isFinite(struct.target1)) {
          const outcome = pathOutcome(s.d.candles, s.idx, pExitIdx, struct.stop, struct.target1, dir === 'BUY');
          const b = calib[calibrationBand(score)];
          b.n++;
          if (outcome === 'hit') b.hits++;
          else if (outcome === 'stop') b.stopped++;
          else b.neither++;
        }
      }

      // Per-horizon evaluation: one score per checkpoint, forward outcome
      // measured at 5d, 21d AND the CLI horizon.
      for (const h of HORIZONS) {
        const exitIdx = s.d.candles.findIndex((c) => c.t >= s.c0.t + h * DAY_MS);
        if (exitIdx < 0) continue;
        const c1 = s.d.candles[exitIdx];
        // SPY forward return over the same window
        const spy0 = spy.find((x) => x.t >= s.c0.t);
        const spy1 = spy.find((x) => x.t >= c1.t);
        if (!spy0 || !spy1) continue;
        const fwd = ((c1.close - s.c0.close) / s.c0.close) * 100;
        const spyFwd = ((spy1.c - spy0.c) / spy0.c) * 100;
        // Net of liquidity-scaled costs. SELL = short: gross -fwd.
        const netFwd = action === 'SELL' ? -fwd - costRtPct : fwd - costRtPct;
        const B = byH.get(h);
        B.action[action].push(fwd);
        B.spy[action].push(spyFwd);
        if (action === 'BUY' || action === 'SELL') {
          B.net[action].push(netFwd);
          B.spyNet[action].push(spyFwd);
        }
        let ts = tickerStats.get(h)[action].get(s.ticker);
        if (!ts) { ts = { fwd: [], spy: [] }; tickerStats.get(h)[action].set(s.ticker, ts); }
        ts.fwd.push(fwd);
        ts.spy.push(spyFwd);
        if (h === HORIZON) {
          legacyBuckets[legacyAction].push(fwd);
          legacySpyBuckets[legacyAction].push(spyFwd);
          // Rank-performance record at the primary horizon.
          rankRecords.push({ monthKey, ticker: s.ticker, score, fwd, spyFwd, alpha: fwd - spyFwd });
        }
      }
      totalSignals++;
    }

    doneCheckpoints++;
    if (doneCheckpoints % checkpointLogEvery === 0) {
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      console.log(`[ckpt ${doneCheckpoints}/${checkpointCount}] ${monthKey} signals=${totalSignals} | BUY avg ${avg(primary.action.BUY).toFixed(1)}% (n=${primary.action.BUY.length}) | SELL avg ${avg(primary.action.SELL).toFixed(1)}% (n=${primary.action.SELL.length}) | SPY-BUY avg ${avg(primary.spy.BUY).toFixed(1)}%`);
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const winRate = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : 0);
  const r2 = (v) => Number(v.toFixed(2));

  // Per-action summary including net-of-costs metrics (traded signals only),
  // parameterized by horizon.
  const actionSummary = (h, name) => {
    const B = byH.get(h);
    const raw = {
      n: B.action[name].length,
      avgForwardReturn: r2(avg(B.action[name])),
      median: r2(median(B.action[name])),
      winRate: +winRate(B.action[name]).toFixed(1),
      spyAvgSameWindows: r2(avg(B.spy[name])),
    };
    // Cash-relative alpha is the PRIMARY reported metric. With a ~0 risk-free
    // proxy over 90d windows it equals the raw forward return (gross); net of
    // costs it equals the net forward return.
    raw.avgCashAlpha = raw.avgForwardReturn;
    raw.avgAlpha = r2(raw.avgForwardReturn - raw.spyAvgSameWindows); // secondary: vs SPY
    if (name === 'BUY' || name === 'SELL') {
      raw.netOfCosts = {
        avgReturn: r2(avg(B.net[name])),
        winRate: +winRate(B.net[name]).toFixed(1),
        avgCashAlpha: r2(avg(B.net[name])),
        avgAlpha: r2(avg(B.net[name]) - avg(B.spyNet[name])), // secondary: vs SPY
        note: name === 'SELL' ? 'short interpretation: gross = -forward return' : 'long',
      };
    }
    return raw;
  };
  const legacySummary = (name) => ({
    n: legacyBuckets[name].length,
    avgForwardReturn: r2(avg(legacyBuckets[name])),
    winRate: +winRate(legacyBuckets[name]).toFixed(1),
    spyAvgSameWindows: r2(avg(legacySpyBuckets[name])),
    avgCashAlpha: r2(avg(legacyBuckets[name])), // primary: vs cash (risk-free ≈ 0)
    avgAlpha: r2(avg(legacyBuckets[name]) - avg(legacySpyBuckets[name])), // secondary: vs SPY
  });

  const calibration = {};
  for (const band of BAND_ORDER) {
    const b = calib[band];
    calibration[band] = {
      n: b.n,
      hits: b.hits,
      stoppedFirst: b.stopped,
      neitherInHorizon: b.neither,
      hitRate: b.n ? +(100 * b.hits / b.n).toFixed(1) : null,
      // Observed confidence the engine should quote for this band.
      confidence: b.n ? Math.round(100 * b.hits / b.n) : null,
    };
  }

  // Per-horizon reports + bootstrap 95% CIs on ticker-level means
  // (Newey-West-style clustering: overlapping checkpoints within a ticker are
  // absorbed by resampling the TICKER as the independent unit).
  // Two views per action:
  //   bootstrap95ci      — SPY-relative alpha (secondary benchmark view)
  //   bootstrap95ciCash  — cash-relative expected return = raw forward return
  //                        (PRIMARY view; risk-free proxy ≈ 0 over 90d windows)
  const bootstrapCiFor = (h, name) => {
    const m = tickerStats.get(h)[name];
    if (m.size < 2) return null;
    const alphas = [...m.values()].map((s) => avg(s.fwd) - avg(s.spy));
    const ci = bootstrapCi(alphas);
    return {
      tickers: m.size,
      meanAlpha: r2(avg(alphas)),
      ci95: ci ? [r2(ci.lo), r2(ci.hi)] : null,
      significantAt95: ci ? ci.lo > 0 || ci.hi < 0 : false,
    };
  };
  const bootstrapCiForCash = (h, name) => {
    const m = tickerStats.get(h)[name];
    if (m.size < 2) return null;
    const rets = [...m.values()].map((s) => avg(s.fwd)); // vs cash = raw forward return
    const ci = bootstrapCi(rets);
    return {
      tickers: m.size,
      meanForwardReturn: r2(avg(rets)),
      ci95: ci ? [r2(ci.lo), r2(ci.hi)] : null,
      significantAt95: ci ? ci.lo > 0 || ci.hi < 0 : false,
    };
  };
  const horizonReports = {};
  for (const h of HORIZONS) {
    horizonReports[h] = {
      horizonDays: h,
      actions: { BUY: actionSummary(h, 'BUY'), HOLD: actionSummary(h, 'HOLD'), SELL: actionSummary(h, 'SELL') },
      bootstrap95ci: { BUY: bootstrapCiFor(h, 'BUY'), HOLD: bootstrapCiFor(h, 'HOLD'), SELL: bootstrapCiFor(h, 'SELL') },
      bootstrap95ciCash: { BUY: bootstrapCiForCash(h, 'BUY'), HOLD: bootstrapCiForCash(h, 'HOLD'), SELL: bootstrapCiForCash(h, 'SELL') },
    };
  }

  // ================= rank performance (quantile monotonicity) ================
  const byMonth = new Map();
  for (const rec of rankRecords) {
    if (!byMonth.has(rec.monthKey)) byMonth.set(rec.monthKey, []);
    byMonth.get(rec.monthKey).push(rec);
  }
  const perMonth = [];
  const pooledAlpha = [[], [], [], [], []]; // quintile 1..5
  const pooledFwd = [[], [], [], [], []];
  for (const [monthKey, recs] of [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (recs.length < RANK_MIN_UNIVERSE) continue;
    // Deterministic order: ascending score, ticker as tie-break.
    recs.sort((a, b) => a.score - b.score || (a.ticker < b.ticker ? -1 : 1));
    const qAlpha = [[], [], [], [], []];
    const qFwd = [[], [], [], [], []];
    recs.forEach((rec, pos) => {
      const q = quintileOf(pos, recs.length) - 1;
      qAlpha[q].push(rec.alpha);
      qFwd[q].push(rec.fwd);
    });
    const meanAlpha = qAlpha.map((a) => avg(a));
    const meanFwd = qFwd.map((a) => avg(a));
    const bucketIdx = [1, 2, 3, 4, 5];
    const spAlpha = spearman(bucketIdx, meanAlpha);
    const spFwd = spearman(bucketIdx, meanFwd);
    const peAlpha = pearson(bucketIdx, meanAlpha);
    const topMinusMid = meanAlpha[4] - meanAlpha[2];
    perMonth.push({
      monthKey,
      n: recs.length,
      spearmanAlpha: spAlpha == null ? null : +spAlpha.toFixed(3),
      spearmanRaw: spFwd == null ? null : +spFwd.toFixed(3),
      pearsonAlpha: peAlpha == null ? null : +peAlpha.toFixed(3),
      bucketMeanAlpha: meanAlpha.map((v) => +v.toFixed(2)),
      bucketMeanFwd: meanFwd.map((v) => +v.toFixed(2)),
      topMinusMid: +topMinusMid.toFixed(2),
      topAboveMid: meanAlpha[4] > meanAlpha[2],
    });
    for (let q = 0; q < RANK_BUCKETS; q++) {
      pooledAlpha[q].push(...qAlpha[q]);
      pooledFwd[q].push(...qFwd[q]);
    }
  }
  const summarizeMonths = (months) => {
    const sp = months.map((m) => m.spearmanAlpha).filter((v) => v != null);
    return {
      months: months.length,
      avgSpearman: sp.length ? +avg(sp).toFixed(3) : null,
      medianSpearman: sp.length ? +median(sp).toFixed(3) : null,
      positiveShare: sp.length ? +((100 * sp.filter((v) => v > 0).length) / sp.length).toFixed(1) : null,
      avgTopMinusMid: months.length ? +avg(months.map((m) => m.topMinusMid)).toFixed(2) : null,
      topAboveMidShare: months.length ? +((100 * months.filter((m) => m.topAboveMid).length) / months.length).toFixed(1) : null,
    };
  };
  const half = Math.floor(perMonth.length / 2);
  const pooledQuintiles = [];
  for (let q = 0; q < RANK_BUCKETS; q++) {
    pooledQuintiles.push({
      quintile: q + 1,
      n: pooledAlpha[q].length,
      meanAlpha: r2(avg(pooledAlpha[q])),
      meanForwardReturn: r2(avg(pooledFwd[q])),
    });
  }
  const overall = summarizeMonths(perMonth);
  const halves = { first: summarizeMonths(perMonth.slice(0, half)), second: summarizeMonths(perMonth.slice(half)) };
  const topQ = pooledQuintiles[RANK_BUCKETS - 1];
  const midQ = pooledQuintiles[Math.floor(RANK_BUCKETS / 2)];
  const monotone = pooledQuintiles.every((q, i) => i === 0 || q.meanAlpha >= pooledQuintiles[i - 1].meanAlpha - 0.01);
  const rankPerformance = {
    horizonDays: HORIZON,
    bucketCount: RANK_BUCKETS,
    minUniversePerMonth: RANK_MIN_UNIVERSE,
    monthsTested: perMonth.length,
    observations: rankRecords.length,
    perMonth: overall,
    halves,
    pooledQuintiles,
    topVsMiddle: {
      topQuintileMeanAlpha: topQ.meanAlpha,
      middleQuintileMeanAlpha: midQ.meanAlpha,
      spread: r2(topQ.meanAlpha - midQ.meanAlpha),
    },
    pooledMonotone: monotone,
    verdict:
      overall.avgSpearman != null && overall.avgSpearman > 0 && topQ.meanAlpha > midQ.meanAlpha
        ? (halves.first.avgSpearman > 0 && halves.second.avgSpearman > 0 ? 'PASS — positive Spearman, top bucket above middle, consistent across halves' : 'MIXED — positive Spearman and top bucket above middle, but halves disagree')
        : 'FAIL — no positive monotone score-return relationship',
    note: 'Per checkpoint month: bucket the scored universe into score quintiles (5=top scores), mean forward return/alpha per bucket vs SPY same-window. Spearman = rank correlation of bucket index vs mean alpha. Pooled quintiles weight every checkpoint observation equally; forward windows overlap, so treat pooled means as descriptive, the per-month Spearman distribution as the significance signal.',
    perMonthDetail: perMonth,
  };

  // Cost model observations.
  const sortedCosts = [...costSamples].sort((a, b) => a - b);
  const costModel = {
    form: 'square-root impact: perSidePct = K × σ20(daily log returns) × sqrt(orderNotional / 10d-median daily dollar volume)',
    impactCoefficientK: IMPACT_K,
    orderNotionalUsd: NOTIONAL_USD,
    floorBpsPerSide: COST_FLOOR_BPS_PER_SIDE,
    capBpsPerSide: COST_CAP_BPS_PER_SIDE,
    flatFallbackBpsPerSide: FLAT_FALLBACK_BPS_PER_SIDE,
    fallbackUsedShare: totalSignals ? +((100 * costFallbacks) / totalSignals).toFixed(1) : null,
    observed: sortedCosts.length
      ? {
          n: sortedCosts.length,
          medianBpsPerSide: +median(sortedCosts).toFixed(1),
          meanBpsPerSide: +avg(sortedCosts).toFixed(1),
          p10BpsPerSide: +sortedCosts[Math.floor(sortedCosts.length * 0.1)].toFixed(1),
          p90BpsPerSide: +sortedCosts[Math.floor(sortedCosts.length * 0.9)].toFixed(1),
        }
      : null,
    note: 'Applied per traded signal (BUY long, SELL short) as entry + exit (2 × per-side). HOLD signals are not traded and pay nothing.',
  };

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      years: YEARS, horizonDays: HORIZON, horizons: HORIZONS, universe: tickers.length,
      costModel,
      fundamentalsGate: 'filed_at <= asOf (filing date); legacy NULL-filed_at rows use a conservative 45-day post-period-end approximation',
      percentileComposition: {
        basis: 'cross-sectional percentile within sector_label (GICS) at each checkpoint; universe-wide fallback when a sector has < 5 names with the factor; factor drops out when neither supports it',
        sectorBasisObservations: pctSectorBasis,
        universeBasisObservations: pctUniverseBasis,
        absentObservations: pctAbsent,
      },
      bootstrap: { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED, unit: 'ticker-level means (robust to overlapping checkpoints)', reportedFor: ['cash-relative expected return (primary)', 'SPY-relative alpha (secondary)'] },
      reporting: {
        primaryMetric: 'expected absolute forward return = alpha vs cash (risk-free proxy ≈ 0 over 90d windows, i.e. the raw forward return); reported as avgCashAlpha / bootstrap95ciCash',
        secondaryMetric: 'SPY-relative alpha over the same windows (buy-and-hold SPY benchmark); reported as avgAlpha / bootstrap95ci',
        reference: 'tmp/entry-timing-summary.md (2026-10-27) — cash-relative reporting adopted: the SPY-relative sign is a benchmark/weighting choice, not a stable property of the picks',
      },
      note: 'Quant-core only (trend+RSI+sentiment=0+percentile-composited fundamentals+12-1 momentum). News/LLM excluded — no honest historical news feed. Results are a lower bound.',
    },
    totals: { signals: totalSignals, tickersTested: tickerData.size, tickersSkipped: skippedNoData, checkpoints: doneCheckpoints },
    // Primary (--horizon) summary, kept at top level for existing consumers.
    actions: horizonReports[HORIZON].actions,
    // Per-horizon evaluation + significance CIs (5d / 21d / CLI horizon).
    horizons: horizonReports,
    // Rank performance: quantile monotonicity test of score vs forward return.
    rankPerformance,
    // Before/after: exact legacy behavior re-scored over the same checkpoints.
    legacy: {
      note: 'Pre-composition method: tiered absolute-threshold fundamentals, no sector percentiles, no momentum block, simple-average RSI.',
      actions: { BUY: legacySummary('BUY'), HOLD: legacySummary('HOLD'), SELL: legacySummary('SELL') },
    },
    calibration,
    perTickerSample: [...tickerData.keys()].slice(0, 20).map((ticker) => ({ ticker, signals: rankRecords.filter((r) => r.ticker === ticker).length })),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  // ---- calibration.json (consumed by quantEngine confidence lookup) --------
  const calibrationDoc = {
    generatedAt: report.generatedAt,
    source: 'scripts/backtest-verdicts.mjs',
    config: { years: YEARS, horizonDays: HORIZON, signals: totalSignals, costModel: 'liquidity-scaled square-root impact (see backtest-report.json config.costModel)' },
    note: 'confidence = observed share of signals in the score band whose target1 was reached within the horizon before the stop (levels structure: window-5 fractal pivots + ATR-14, same as the live trade plan). Bands are half-open: [lo, hi) except >=35.',
    bands: calibration,
  };
  fs.writeFileSync(CALIBRATION_OUT, JSON.stringify(calibrationDoc, null, 2));

  console.log('\n===== BACKTEST SUMMARY (percentile composition, liquidity-scaled costs) =====');
  console.log('Primary metric = expected absolute forward return (vs cash, risk-free ≈ 0). SPY-relative alpha is secondary.');
  for (const h of HORIZONS) {
    console.log(`--- ${h}d horizon ---`);
    for (const [a, s] of Object.entries(horizonReports[h].actions)) {
      console.log(`${a.padEnd(5)} n=${String(s.n).padStart(4)} | expected ${h}d return (vs cash) ${s.avgCashAlpha > 0 ? '+' : ''}${s.avgCashAlpha}% | win ${s.winRate}% | vs SPY ${s.avgAlpha > 0 ? '+' : ''}${s.avgAlpha}%${s.netOfCosts ? ` | NET of costs ${s.netOfCosts.avgReturn > 0 ? '+' : ''}${s.netOfCosts.avgReturn}% win ${s.netOfCosts.winRate}% (vs cash; vs SPY ${s.netOfCosts.avgAlpha > 0 ? '+' : ''}${s.netOfCosts.avgAlpha}%)` : ''}`);
    }
  }
  console.log(`\n===== BOOTSTRAP 95% CI (ticker-level means, ${BOOTSTRAP_DRAWS} draws, seed ${BOOTSTRAP_SEED} — overlapping-checkpoint robust) =====`);
  for (const h of HORIZONS) {
    for (const a of ['BUY', 'HOLD', 'SELL']) {
      const cc = horizonReports[h].bootstrap95ciCash[a];
      const c = horizonReports[h].bootstrap95ci[a];
      if (!cc || !c) { console.log(`${String(h).padStart(3)}d ${a.padEnd(5)} n/a (fewer than 2 tickers)`); continue; }
      const [clo, chi] = cc.ci95;
      const [lo, hi] = c.ci95;
      console.log(`${String(h).padStart(3)}d ${a.padEnd(5)} expected return vs cash ${cc.meanForwardReturn > 0 ? '+' : ''}${cc.meanForwardReturn}% [${clo}%, ${chi}%] → ${cc.significantAt95 ? 'SIGNIFICANT at 95%' : 'not significant at 95%'} | vs SPY alpha ${c.meanAlpha > 0 ? '+' : ''}${c.meanAlpha}% [${lo}%, ${hi}%] → ${c.significantAt95 ? 'SIGNIFICANT at 95%' : 'not significant at 95%'} (${cc.tickers} tickers)`);
    }
  }
  console.log('\n===== RANK PERFORMANCE (quantile monotonicity, P123-style) =====');
  console.log(`Horizon ${HORIZON}d | months tested ${rankPerformance.monthsTested} | observations ${rankPerformance.observations} | buckets ${RANK_BUCKETS} (5 = top scores)`);
  console.log(`Spearman (bucket vs alpha): mean ${overall.avgSpearman == null ? 'n/a' : (overall.avgSpearman > 0 ? '+' : '') + overall.avgSpearman} | median ${overall.medianSpearman == null ? 'n/a' : (overall.medianSpearman > 0 ? '+' : '') + overall.medianSpearman} | positive in ${overall.positiveShare == null ? 'n/a' : overall.positiveShare + '%'} of months`);
  console.log(`First half: mean Spearman ${halves.first.avgSpearman == null ? 'n/a' : (halves.first.avgSpearman > 0 ? '+' : '') + halves.first.avgSpearman} (${halves.first.months} months) | Second half: ${halves.second.avgSpearman == null ? 'n/a' : (halves.second.avgSpearman > 0 ? '+' : '') + halves.second.avgSpearman} (${halves.second.months} months)`);
  console.log(`Pooled quintile mean alpha (Q1=worst scores → Q5=best): ${pooledQuintiles.map((q) => `Q${q.quintile} ${q.meanAlpha > 0 ? '+' : ''}${q.meanAlpha}% (n=${q.n})`).join(' | ')}`);
  console.log(`Top vs middle quintile: ${rankPerformance.topVsMiddle.spread > 0 ? '+' : ''}${rankPerformance.topVsMiddle.spread}% | pooled monotone: ${monotone ? 'yes' : 'no'}`);
  console.log(`VERDICT: ${rankPerformance.verdict}`);
  console.log('\n===== COST MODEL (liquidity-scaled) =====');
  console.log(`${costModel.form} | K=${IMPACT_K} | notional $${NOTIONAL_USD.toLocaleString()}`);
  if (costModel.observed) console.log(`observed per-side: median ${costModel.observed.medianBpsPerSide}bps | mean ${costModel.observed.meanBpsPerSide}bps | p10 ${costModel.observed.p10BpsPerSide}bps | p90 ${costModel.observed.p90BpsPerSide}bps (fallback used for ${costModel.fallbackUsedShare}% of signals)`);
  console.log('\n===== BEFORE/AFTER vs legacy method (same checkpoints) =====');
  for (const a of ['BUY', 'HOLD', 'SELL']) {
    const o = report.actions[a];
    const l = report.legacy.actions[a];
    console.log(`${a.padEnd(5)} n=${String(l.n).padStart(4)} | expected return (vs cash) ${l.avgCashAlpha > 0 ? '+' : ''}${l.avgCashAlpha}% -> ${o.avgCashAlpha > 0 ? '+' : ''}${o.avgCashAlpha}% (raw) / ${o.netOfCosts ? `${o.netOfCosts.avgCashAlpha > 0 ? '+' : ''}${o.netOfCosts.avgCashAlpha}% (net)` : 'n/a'} | vs SPY alpha ${l.avgAlpha > 0 ? '+' : ''}${l.avgAlpha}% -> ${o.avgAlpha > 0 ? '+' : ''}${o.avgAlpha}% | win ${l.winRate}% -> ${o.winRate}%`);
  }
  console.log('\n===== CALIBRATION (score band -> target1 hit-rate) =====');
  for (const band of BAND_ORDER) {
    const c = calibration[band];
    console.log(`${band.padEnd(9)} n=${String(c.n).padStart(4)} hit ${c.hitRate == null ? '—' : c.hitRate + '%'} (stopped-first ${c.stoppedFirst}, neither ${c.neitherInHorizon})`);
  }
  console.log(`\nReport saved: ${OUT}\nCalibration saved: ${CALIBRATION_OUT}`);
  await conn.closeSync();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
