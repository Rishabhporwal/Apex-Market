/**
 * svc-verdict quant core — EXACT port of src/services/quantEngine.ts.
 * Pure functions only: no fetches, no globals, no Date.now().
 * Single source of truth requirement: scoring must match the monolith's
 * backtester bit-for-bit (trend ±25, RSI ±15, news ±25 clamped /4,
 * fundamentals ±35 clamped, BUY>=35, SELL needs 2 bearish votes).
 * Confidence comes from the backtest calibration table when
 * data/calibration.json is present (fallback: legacy formula, calibrated:false).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Indicator math ----
export function sma(values, period) {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return undefined;
  // Wilder smoothing (industry standard — matches TradingView/broker charts).
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
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(candles, period = 14) {
  if (candles.length < period + 1) return undefined;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

/** Fractal pivots — window 5, dedupe 0.5% (same as levelsService/quantEngine). */
export function pivotLevels(candles, window = 5, dedupePct = 0.005) {
  const supports = [];
  const resistances = [];
  const close = candles[candles.length - 1]?.close ?? 0;
  if (!close || candles.length < window * 2 + 1) return { supports, resistances };

  for (let i = window; i < candles.length - window; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) resistances.push(c.high);
    if (isLow) supports.push(c.low);
  }

  const dedupe = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const out = [];
    for (const v of sorted) {
      if (!out.length || Math.abs(v - out[out.length - 1]) / out[out.length - 1] > dedupePct) out.push(v);
    }
    return out;
  };
  return { supports: dedupe(supports), resistances: dedupe(resistances) };
}

// ---- Confidence calibration (P0-1 audit fix) -------------------------------
// The backtester (scripts/backtest-verdicts.mjs) emits data/calibration.json:
// score band -> OBSERVED share of signals that reached target1 within the
// horizon before hitting the stop. Confidence is that observed hit-rate — a
// measured number, not min(95, 45+|score|/2) folklore.
//
// calibrationBand() here MUST stay in lockstep with calibrationBand() in
// scripts/backtest-verdicts.mjs, and confidenceForScore() MUST stay in
// lockstep with the same functions in src/services/quantEngine.ts.
export const CALIBRATION_BANDS = ['<-35', '-35..-15', '-15..15', '15..35', '>=35'];

export function calibrationBand(score) {
  if (score >= 35) return '>=35';
  if (score >= 15) return '15..35';
  if (score > -15) return '-15..15';
  if (score >= -35) return '-35..-15';
  return '<-35';
}

/** data/calibration.json location: DATA_DIR override, else <repo>/data. */
export function calibrationFilePath() {
  const dataDir = process.env.DATA_DIR;
  return dataDir
    ? path.join(dataDir, 'calibration.json')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/calibration.json');
}

// undefined = not attempted yet; null = attempted and unavailable.
let calibrationCache;
export function loadCalibration() {
  if (calibrationCache !== undefined) return calibrationCache;
  calibrationCache = null;
  try {
    const raw = JSON.parse(fs.readFileSync(calibrationFilePath(), 'utf8'));
    const bands = raw?.bands;
    if (bands && CALIBRATION_BANDS.every((b) => bands[b] && typeof bands[b].hitRate === 'number')) {
      calibrationCache = bands;
    }
  } catch {
    /* missing or corrupt calibration -> legacy formula fallback */
  }
  return calibrationCache;
}

/** Test/debug hook: inject bands directly (null clears back to legacy). */
export function setCalibration(bands) {
  calibrationCache = bands;
}

/** confidence + calibrated flag for a score. Mirrors quantEngine.ts exactly. */
export function confidenceForScore(score) {
  const bands = loadCalibration();
  if (bands) {
    const band = bands[calibrationBand(score)];
    if (band && typeof band.hitRate === 'number') {
      return { confidence: Math.round(band.hitRate), calibrated: true };
    }
  }
  // Legacy fallback (pre-calibration formula).
  return { confidence: Math.round(Math.min(95, 45 + Math.abs(score) / 2)), calibrated: false };
}

// Boot: warm the calibration table once at module load (svc-verdict import).
loadCalibration();

// ---- Trend classification ----
export function classifyTrend(price, sma50, sma200) {
  if (sma50 && sma200) {
    if (price > sma50 && sma50 > sma200) return 'up';
    if (price < sma50 && sma50 < sma200) return 'down';
  }
  return 'sideways';
}

// ---- Sector-relative fundamentals (P1-2 audit fix) ---------------------------
// Midpoint percentile rank of x within a sorted array of sector peers:
// (values strictly below + half of the tied ones) / n * 100 → 0..100.
// Requires at least 5 peers — a smaller sample is too noisy to rank against,
// so the caller falls back to absolute thresholds. Mirrored in quantEngine.ts.
export function percentileRank(sortedValues, x) {
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

// ---- Percentile-rank composition (v2) ---------------------------------------
// Replaces the 4-tier point buckets for the fundamentals block with a
// continuous cross-sectional percentile composition (Portfolio123-style):
//   1. each factor is a cross-sectional percentile 0-100 within its sector,
//   2. percentiles are made directional (higher = better),
//   3. the weighted average over factors WITH percentile support is taken
//      with weights RENORMALIZED over the present factors, so missing data
//      compresses nothing (P123-style renormalization — the composite keeps
//      the full 0-100 span regardless of how many factors have data),
//   4. the composite maps linearly onto the EXISTING ±35 fundamentals scale:
//      fundPts = (composite − 50) / 50 × 35, clamped ±35 — score scale,
//      action thresholds and calibration bands are unchanged.
// Weights mirror the old tier maxima (growth ±12, margin ±9, roe ±8, pe ±6,
// total 35) so relative factor importance is preserved. When NO factor has a
// percentile (sector stats unavailable), the original absolute-threshold
// tiers still apply. Mirrored in quantEngine.ts — keep in lockstep.
const FUNDAMENTAL_FACTORS = [
  { key: 'growth', weight: 12, direction: 1, raw: 'revenueGrowthYoY', label: 'Revenue growth (YoY)', fmt: (v) => `${v.toFixed(1)}%` },
  { key: 'margin', weight: 9, direction: 1, raw: 'netMargin', label: 'Net margin', fmt: (v) => `${v.toFixed(1)}%` },
  { key: 'roe', weight: 8, direction: 1, raw: 'roe', label: 'Return on equity', fmt: (v) => `${v.toFixed(1)}%` },
  { key: 'pe', weight: 6, direction: -1, raw: 'peRatio', label: 'P/E ratio', fmt: (v) => v.toFixed(1) },
];

/** Stretch a weighted average back over [lo, hi] (renormalization guard). */
export function renormalize(weightedSum, weightSum, lo = 0, hi = 100) {
  if (!(weightSum > 0)) return undefined;
  const avg = weightedSum / weightSum;
  return hi > lo ? ((avg - lo) / (hi - lo)) * 100 : 50;
}

/** Continuous percentile composition of the fundamentals block (see above). */
export function fundamentalsComposite(pct, fundamentals) {
  let weightedSum = 0;
  let weightSum = 0;
  const rows = [];
  for (const f of FUNDAMENTAL_FACTORS) {
    const raw = fundamentals ? fundamentals[f.raw] : undefined;
    const pctile = pct ? pct[f.key] : undefined;
    if (raw === undefined || !Number.isFinite(raw) || pctile === undefined) continue;
    const directional = f.direction > 0 ? pctile : 100 - pctile;
    weightedSum += f.weight * directional;
    weightSum += f.weight;
    rows.push({ factor: f, raw, pctile, directional });
  }
  if (!rows.length) return undefined;
  const composite = renormalize(weightedSum, weightSum) ?? 50;
  const unclamped = ((composite - 50) / 50) * 35;
  return {
    points: Math.max(-35, Math.min(35, unclamped)),
    composite: Math.round(composite * 10) / 10,
    factors: rows.map(({ factor: f, raw, pctile, directional }) => ({
      name: f.label,
      // Per-factor weighted contribution — sums to the composite points
      // before the ±35 clamp (weights renormalize to 1 over present factors).
      points: Math.round((((directional - 50) / 50) * f.weight) * 100) / 100,
      value: `${f.fmt(raw)} (sector pctile ${pctile}/100)`,
    })),
  };
}

// ---- 12-1 momentum (skip-1m) ------------------------------------------------
// Classic 11-month return EXCLUDING the most recent month:
//   m = close[t−21 trading days] / close[t−252 trading days] − 1.
// Skipping the recent month avoids the short-term reversal that contaminates
// raw 12-month returns. Needs ≥ 253 daily closes. Scored on a fixed absolute
// curve (±20% return → the full ±10 block, ~10% weight per published factor
// bands) that is IDENTICAL in backtest and live — candle-derived, so no
// cross-sectional distribution is required. Mirrored in quantEngine.ts.
export function momentum121(closes) {
  if (!Array.isArray(closes) || closes.length < 253) return undefined;
  const past = closes[closes.length - 253];
  const prev = closes[closes.length - 22];
  if (!(past > 0) || !(prev > 0)) return undefined;
  return prev / past - 1;
}

const MOMENTUM_BLOCK_MAX = 10;

// ---- The core scoring function (mirrors aiVerdictService exactly) ----
export function scoreVerdict(input) {
  const { price, candles, fundamentals, sentimentScore = 0, sectorPercentiles } = input;
  const pct = sectorPercentiles || {};

  const closes = candles.map((c) => c.close);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const trend = classifyTrend(price, s50, s200);
  const rsiVal = rsi(closes, 14);

  let score = 0;
  // Trend alignment ±25
  let trendPts = 0;
  if (trend === 'up') trendPts = 25;
  else if (trend === 'down') trendPts = -25;
  score += trendPts;
  // RSI position ±15
  let rsiPts = 0;
  let rsiDetail = 'insufficient history for RSI(14)';
  if (rsiVal !== undefined) {
    const r = rsiVal.toFixed(1);
    if (rsiVal < 30) { rsiPts = 15; rsiDetail = `RSI ${r} — oversold (rebound zone)`; }
    else if (rsiVal < 45) { rsiPts = 7; rsiDetail = `RSI ${r} — cooling off, favorable entry range`; }
    else if (rsiVal > 70) { rsiPts = -15; rsiDetail = `RSI ${r} — overbought (exhaustion risk)`; }
    else if (rsiVal > 55) { rsiPts = -7; rsiDetail = `RSI ${r} — hot, stretched momentum`; }
    else { rsiDetail = `RSI ${r} — neutral zone (no points)`; }
  }
  score += rsiPts;
  // News sentiment ±25 (clamped)
  const sentPts = Math.max(-25, Math.min(25, sentimentScore / 4));
  score += sentPts;
  // Fundamentals ±35 (clamped). With sector percentiles: continuous
  // percentile-rank composition (weighted, renormalized over present factors,
  // mapped onto the existing ±35 scale). Without: original absolute tiers.
  let fundamentalsUsed = false;
  let fundPts = 0;
  let fundFactors = [];
  let fundComposite;
  if (fundamentals) {
    fundamentalsUsed = true;
    const comp = fundamentalsComposite(pct, fundamentals);
    if (comp) {
      fundPts = comp.points;
      fundComposite = comp.composite;
      fundFactors = comp.factors;
    } else {
      // Absolute-threshold fallback (no cross-sectional support available).
      if (fundamentals.revenueGrowthYoY !== undefined) {
        const g = fundamentals.revenueGrowthYoY;
        const p = g > 10 ? 12 : g > 0 ? 6 : g > -10 ? -6 : -12;
        fundPts += p;
        fundFactors.push({ name: 'Revenue growth (YoY)', value: `${g.toFixed(1)}%`, points: p });
      }
      if (fundamentals.netMargin !== undefined) {
        const m = fundamentals.netMargin;
        const p = m > 20 ? 9 : m > 5 ? 5 : m > 0 ? 0 : -9;
        fundPts += p;
        fundFactors.push({ name: 'Net margin', value: `${m.toFixed(1)}%`, points: p });
      }
      if (fundamentals.roe !== undefined) {
        const r = fundamentals.roe;
        const p = r > 20 ? 8 : r > 10 ? 4 : r > 0 ? 0 : -8;
        fundPts += p;
        fundFactors.push({ name: 'Return on equity', value: `${r.toFixed(1)}%`, points: p });
      }
      if (fundamentals.peRatio !== undefined) {
        const pe = fundamentals.peRatio;
        const p = pe > 0 && pe < 25 ? 6 : pe >= 25 && pe <= 60 ? 0 : -6;
        fundPts += p;
        fundFactors.push({ name: 'P/E ratio', value: pe.toFixed(1), points: p });
      }
      fundPts = Math.max(-35, Math.min(35, fundPts));
    }
    score += fundPts;
  }

  // 12-1 momentum (skip-1m) ±10 — candle-derived, identical backtest/live.
  const m121 = momentum121(closes);
  let momPts = 0;
  if (m121 !== undefined) {
    momPts = Math.max(-MOMENTUM_BLOCK_MAX, Math.min(MOMENTUM_BLOCK_MAX, m121 * 50));
    score += momPts;
  }

  score = Math.round(Math.max(-100, Math.min(100, score)));

  let action;
  let bearishVotes;
  if (score >= 35) action = 'BUY';
  else if (score >= 15) action = 'HOLD'; // bullish lean — summary text conveys it
  else if (score > -15) action = 'HOLD';
  else {
    // SELL requires confirmation: a bare low score is frequently a temporary
    // dip in a structurally sound company (value traps). Demand at least TWO
    // independent bearish confirmations from {trend, fundamentals, momentum}.
    let bearishVoteCount = 0;
    const reasons = [];
    if (trend === 'down') { bearishVoteCount++; reasons.push('downtrend (price below SMA50 & SMA200)'); }
    if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) { bearishVoteCount++; reasons.push('deteriorating fundamentals (shrinking revenue or negative margin)'); }
    if (rsiVal !== undefined && rsiVal > 70) { bearishVoteCount++; reasons.push('momentum exhaustion (RSI > 70)'); }
    action = bearishVoteCount >= 2 ? 'SELL' : 'HOLD';
    bearishVotes = { count: bearishVoteCount, reasons };
  }

  // Confidence: calibrated hit-rate for the score band when
  // data/calibration.json is loaded, else the legacy formula. The `calibrated`
  // flag tells callers which source produced the number.
  const { confidence, calibrated } = confidenceForScore(score);

  const breakdown = {
    score,
    trend: {
      points: trendPts,
      detail: trend === 'up' ? 'price above SMA50 & SMA200 (uptrend)' : trend === 'down' ? 'price below SMA50 & SMA200 (downtrend)' : 'mixed moving averages (sideways)',
    },
    rsi: { points: rsiPts, detail: rsiDetail },
    sentiment: {
      points: Math.round(sentPts * 10) / 10,
      detail: sentimentScore === 0 ? 'no meaningful news sentiment measured' : `news sentiment score ${sentimentScore.toFixed(0)} (÷4, clamped ±25)`,
    },
    fundamentals: {
      points: Math.round(fundPts * 10) / 10,
      max: 35,
      used: fundamentalsUsed,
      factors: fundFactors,
      ...(fundComposite !== undefined ? { composite: fundComposite } : {}),
      ...(fundamentalsUsed ? { basis: fundComposite !== undefined ? 'sector' : 'absolute' } : {}),
      detail: !fundamentalsUsed
        ? 'no EDGAR fundamentals available for this symbol'
        : fundComposite !== undefined
        ? `${fundFactors.length} quality factors from SEC filings, cross-sectional percentile composite ${fundComposite}/100 within sector${pct.sector ? ` (${pct.sector})` : ''}`
        : `${fundFactors.length} quality factors from SEC filings (absolute thresholds — no sector percentiles available)`,
    },
    ...(m121 !== undefined
      ? {
          momentum: {
            points: Math.round(momPts * 10) / 10,
            detail: `12-1 momentum (11-month return excluding the most recent month): ${(m121 * 100).toFixed(1)}% — ±20% maps to the full ±10 block`,
          },
        }
      : {}),
    ...(bearishVotes ? { bearishVotes } : {}),
  };

  return { score, action, confidence, calibrated, trend, rsi14: rsiVal, fundamentalsUsed, breakdown };
}
