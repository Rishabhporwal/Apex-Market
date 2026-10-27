/**
 * Quant core — the deterministic scoring engine of the AI Verdict, extracted
 * so the backtester (scripts/backtest-verdicts.mjs) runs the EXACT same logic
 * as the live verdict. No drift between what we show and what we measured.
 *
 * Pure functions only: no fetches, no globals, no Date.now().
 */
import type { Candle } from '@/types';
// Server-only calibration read (mirrors quantEngine.mjs). No client bundle
// imports this module — the AI verdict is produced server-side.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Trend = 'up' | 'down' | 'sideways';
export type VerdictAction = 'BUY' | 'SELL' | 'HOLD' | 'NEUTRAL';

export interface QuantTechnicals {
  trend: Trend;
  sma20?: number;
  sma50?: number;
  sma200?: number;
  rsi14?: number;
  atr14?: number;
  supports: number[];
  resistances: number[];
}

export interface QuantFundamentals {
  revenueGrowthYoY?: number;
  netMargin?: number;
  roe?: number;
  peRatio?: number;
}

/**
 * Sector-relative percentile inputs (0-100) for the fundamentals factors,
 * computed by the caller from svc-edgar /sector-stats distributions.
 * Any absent factor falls back to the absolute thresholds for that factor.
 */
export interface SectorPercentiles {
  growth?: number;
  margin?: number;
  roe?: number;
  pe?: number;
  /** Sector label, for receipts/display only — never used in the math. */
  sector?: string;
}

export interface ScoreComponent {
  points: number;
  detail: string;
}

/** Per-component receipt of the score — shown verbatim in the UI drill-down. */
export interface QuantBreakdown {
  score: number;
  trend: ScoreComponent;
  rsi: ScoreComponent;
  sentiment: ScoreComponent;
  fundamentals: ScoreComponent & { max: number; used: boolean; factors: { name: string; value: string; points: number }[]; composite?: number };
  /** 12-1 momentum (skip-1m) block, ±10. Absent when history is too short. */
  momentum?: ScoreComponent;
  bearishVotes?: { count: number; reasons: string[] };
}

export interface QuantScoreResult {
  score: number; // -100..100
  action: VerdictAction;
  confidence: number; // 0..100
  /** true when confidence came from the backtest calibration table (data/calibration.json). */
  calibrated: boolean;
  trend: Trend;
  rsi14?: number;
  fundamentalsUsed: boolean;
  breakdown: QuantBreakdown;
}

// ---- Indicator math (duplicated minimal implementations; kept in lockstep with levelsService) ----

export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes: number[], period = 14): number | undefined {
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

export function atr(candles: Candle[], period = 14): number | undefined {
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

/**
 * Fractal pivots — same window logic as levelsService: a bar whose high is the
 * highest of ±window neighbors is a resistance pivot; lowest → support.
 */
export function pivotLevels(candles: Candle[], window = 5, dedupePct = 0.005): { supports: number[]; resistances: number[] } {
  const supports: number[] = [];
  const resistances: number[] = [];
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

  const dedupe = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) {
      if (!out.length || Math.abs(v - out[out.length - 1]) / out[out.length - 1] > dedupePct) out.push(v);
    }
    return out;
  };
  return { supports: dedupe(supports), resistances: dedupe(resistances) };
}

// ---- Confidence calibration (P0-1 audit fix) -------------------------------
// EXACT mirror of services/verdict/quantEngine.mjs `Confidence calibration`
// section — keep both in lockstep (band boundaries, lookup, fallback formula).
// The backtester (scripts/backtest-verdicts.mjs) emits data/calibration.json:
// score band -> OBSERVED share of signals that reached target1 within the
// horizon before hitting the stop. Confidence is that observed hit-rate.

export interface CalibrationBandStats {
  n: number;
  hits: number;
  stoppedFirst: number;
  neitherInHorizon: number;
  hitRate: number | null;
  confidence: number | null;
}
export type CalibrationBands = Record<string, CalibrationBandStats>;

/** Must stay in lockstep with calibrationBand() in quantEngine.mjs and the backtester. */
export const CALIBRATION_BANDS = ['<-35', '-35..-15', '-15..15', '15..35', '>=35'];

export function calibrationBand(score: number): string {
  if (score >= 35) return '>=35';
  if (score >= 15) return '15..35';
  if (score > -15) return '-15..15';
  if (score >= -35) return '-35..-15';
  return '<-35';
}

// undefined = not attempted yet; null = attempted and unavailable.
let calibrationCache: CalibrationBands | null | undefined;

/** data/calibration.json location: DATA_DIR override, else <repo>/data. */
export function calibrationFilePath(): string {
  const dataDir = process.env.DATA_DIR;
  return dataDir
    ? path.join(dataDir, 'calibration.json')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/calibration.json');
}

export function loadCalibration(): CalibrationBands | null {
  if (calibrationCache !== undefined) return calibrationCache;
  calibrationCache = null;
  try {
    const raw = JSON.parse(fs.readFileSync(calibrationFilePath(), 'utf8')) as { bands?: CalibrationBands };
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
export function setCalibration(bands: CalibrationBands | null): void {
  calibrationCache = bands;
}

/** confidence + calibrated flag for a score. Mirrors quantEngine.mjs exactly. */
export function confidenceForScore(score: number): { confidence: number; calibrated: boolean } {
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

// Boot: warm the calibration table once at module load (mirrors quantEngine.mjs).
loadCalibration();

// ---- Trend classification ----

export function classifyTrend(price: number, sma50?: number, sma200?: number): Trend {
  if (sma50 && sma200) {
    if (price > sma50 && sma50 > sma200) return 'up';
    if (price < sma50 && sma50 < sma200) return 'down';
  }
  return 'sideways';
}

// ---- Sector-relative fundamentals (P1-2 audit fix) ---------------------------
// EXACT mirror of services/verdict/quantEngine.mjs `Sector-relative
// fundamentals` section — keep both in lockstep (min sample, midpoint rule,
// percentile → points tiers).
/** Midpoint percentile rank of x within a sorted array of sector peers (0-100). Requires >= 5 peers. */
export function percentileRank(sortedValues: number[], x: number): number | undefined {
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
// tiers still apply. Mirrored in quantEngine.mjs — keep in lockstep.
const FUNDAMENTAL_FACTORS = [
  { key: 'growth', weight: 12, direction: 1, raw: 'revenueGrowthYoY', label: 'Revenue growth (YoY)', fmt: (v: number) => `${v.toFixed(1)}%` },
  { key: 'margin', weight: 9, direction: 1, raw: 'netMargin', label: 'Net margin', fmt: (v: number) => `${v.toFixed(1)}%` },
  { key: 'roe', weight: 8, direction: 1, raw: 'roe', label: 'Return on equity', fmt: (v: number) => `${v.toFixed(1)}%` },
  { key: 'pe', weight: 6, direction: -1, raw: 'peRatio', label: 'P/E ratio', fmt: (v: number) => v.toFixed(1) },
] as const;

/** Stretch a weighted average back over [lo, hi] (renormalization guard). */
export function renormalize(weightedSum: number, weightSum: number, lo = 0, hi = 100): number | undefined {
  if (!(weightSum > 0)) return undefined;
  const avg = weightedSum / weightSum;
  return hi > lo ? ((avg - lo) / (hi - lo)) * 100 : 50;
}

export interface FundamentalsComposite {
  points: number;
  composite: number; // renormalized directional percentile 0-100
  factors: { name: string; value: string; points: number }[];
}

/** Continuous percentile composition of the fundamentals block (see above). */
export function fundamentalsComposite(
  pct: SectorPercentiles,
  fundamentals: QuantFundamentals
): FundamentalsComposite | undefined {
  let weightedSum = 0;
  let weightSum = 0;
  const rows: { factor: (typeof FUNDAMENTAL_FACTORS)[number]; raw: number; pctile: number; directional: number }[] = [];
  for (const f of FUNDAMENTAL_FACTORS) {
    const raw = fundamentals[f.raw];
    const pctile = pct[f.key];
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
// cross-sectional distribution is required. Mirrored in quantEngine.mjs.
export function momentum121(closes: number[]): number | undefined {
  if (!Array.isArray(closes) || closes.length < 253) return undefined;
  const past = closes[closes.length - 253];
  const prev = closes[closes.length - 22];
  if (!(past > 0) || !(prev > 0)) return undefined;
  return prev / past - 1;
}

const MOMENTUM_BLOCK_MAX = 10;

// ---- Factor block weights (v3 — grid-searched) -------------------------------
// Chosen by scripts/weight-search.mjs (323-combo grid over the 3y/90d
// backtest, data/weight-search.json) with a CLUSTER-robustness gate: the
// percentile-composited fundamentals block is ANTI-predictive at this horizon
// (mean per-month Spearman falls monotonically with its weight: 0 → +0.09,
// 50 → −0.12), 12-1 momentum is the strongest ranking signal, RSI helps,
// trend is neutral for ranking. Adopted: trend 0 / rsi 5 / fund 0 / mom 20 /
// sent 25 — overall Spearman −0.052 → +0.187 engine-exact (+0.213 unrounded),
// first half +0.23 / second half +0.14 (both positive, unlike the baseline's
// +0.23/−0.31), top−middle quintile −2.24% → +1.8%. Block points are scaled
// by w/cap and the total renormalized to the shipped 110-point scale, so the
// ±100 clamp, the BUY>=35 / HOLD / SELL thresholds and the calibration bands
// keep their exact meaning. Mirrored in quantEngine.mjs
// and scripts/backtest-verdicts.mjs — keep in lockstep.
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

// ---- The core scoring function (mirrors aiVerdictService exactly) ----

export function scoreVerdict(input: {
  price: number;
  candles: Candle[];
  fundamentals?: QuantFundamentals;
  /** News sentiment score (-100..100). Backtests pass 0 (no honest history). */
  sentimentScore?: number;
  /** Optional sector-relative percentile ranks (0-100) per fundamentals factor. */
  sectorPercentiles?: SectorPercentiles;
}): QuantScoreResult {
  const { price, candles, fundamentals, sentimentScore = 0, sectorPercentiles } = input;
  const pct = sectorPercentiles || {};

  const closes = candles.map((c) => c.close);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const trend = classifyTrend(price, s50, s200);
  const rsiVal = rsi(closes, 14);
  const { supports, resistances } = pivotLevels(candles);

  let score = 0;
  // Trend alignment (raw ±25, weight-scaled)
  let trendPts = 0;
  if (trend === 'up') trendPts = 25;
  else if (trend === 'down') trendPts = -25;
  score += trendPts * BLOCK_MULT.trend;
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
  score += rsiPts * BLOCK_MULT.rsi;
  // News sentiment (raw ±25 clamped, weight-scaled)
  const sentPts = Math.max(-25, Math.min(25, sentimentScore / 4));
  score += sentPts * BLOCK_MULT.sent;
  // Fundamentals ±35 (clamped). With sector percentiles: continuous
  // percentile-rank composition (weighted, renormalized over present factors,
  // mapped onto the existing ±35 scale). Without: original absolute tiers.
  let fundamentalsUsed = false;
  let fundPts = 0;
  let fundFactors: { name: string; value: string; points: number }[] = [];
  let fundComposite: number | undefined;
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
    score += fundPts * BLOCK_MULT.fund;
  }

  // 12-1 momentum (skip-1m) — raw ±10 block, weight-scaled; candle-derived,
  // identical backtest/live.
  const m121 = momentum121(closes);
  let momPts = 0;
  if (m121 !== undefined) {
    momPts = Math.max(-MOMENTUM_BLOCK_MAX, Math.min(MOMENTUM_BLOCK_MAX, m121 * 50));
    score += momPts * BLOCK_MULT.mom;
  }

  score = Math.round(Math.max(-100, Math.min(100, score)));

  let action: VerdictAction;
  let bearishVotes: QuantBreakdown['bearishVotes'];
  if (score >= 35) action = 'BUY';
  else if (score >= 15) action = 'HOLD'; // bullish lean — summary text conveys it
  else if (score > -15) action = 'HOLD';
  else {
    // SELL requires confirmation: a bare low score is frequently a temporary
    // dip in a structurally sound company (value traps). Demand at least TWO
    // independent bearish confirmations from {trend, fundamentals, momentum}.
    let bearishVoteCount = 0;
    const reasons: string[] = [];
    if (trend === 'down') { bearishVoteCount++; reasons.push('downtrend (price below SMA50 & SMA200)'); }
    if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) { bearishVoteCount++; reasons.push('deteriorating fundamentals (shrinking revenue or negative margin)'); }
    if (rsiVal !== undefined && rsiVal > 70) { bearishVoteCount++; reasons.push('momentum exhaustion (RSI > 70)'); }
    action = bearishVoteCount >= 2 ? 'SELL' : 'HOLD';
    bearishVotes = { count: bearishVoteCount, reasons };
  }

  // Confidence: calibrated hit-rate for the score band when
  // data/calibration.json is loaded, else the legacy formula (mirrors .mjs).
  const { confidence, calibrated } = confidenceForScore(score);

  const breakdown: QuantBreakdown = {
    score,
    trend: {
      points: Math.round(trendPts * BLOCK_MULT.trend * 10) / 10,
      detail: trend === 'up' ? 'price above SMA50 & SMA200 (uptrend)' : trend === 'down' ? 'price below SMA50 & SMA200 (downtrend)' : 'mixed moving averages (sideways)',
    },
    rsi: { points: Math.round(rsiPts * BLOCK_MULT.rsi * 10) / 10, detail: rsiDetail },
    sentiment: {
      points: Math.round(sentPts * BLOCK_MULT.sent * 10) / 10,
      detail: sentimentScore === 0 ? 'no meaningful news sentiment measured' : `news sentiment score ${sentimentScore.toFixed(0)} (÷4, clamped ±25, weight-scaled)`,
    },
    fundamentals: {
      points: Math.round(fundPts * BLOCK_MULT.fund * 10) / 10,
      max: Math.round(35 * BLOCK_MULT.fund * 10) / 10,
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
            points: Math.round(momPts * BLOCK_MULT.mom * 10) / 10,
            detail: `12-1 momentum (11-month return excluding the most recent month): ${(m121 * 100).toFixed(1)}% — ±20% maps to the full raw ±10 block (weight-scaled)`,
          },
        }
      : {}),
    ...(bearishVotes ? { bearishVotes } : {}),
  };

  return { score, action, confidence, calibrated, trend, rsi14: rsiVal, fundamentalsUsed, breakdown };
}
