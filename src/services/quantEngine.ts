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
  fundamentals: ScoreComponent & { max: number; used: boolean; factors: { name: string; value: string; points: number }[] };
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

// ---- The core scoring function (mirrors aiVerdictService exactly) ----

export function scoreVerdict(input: {
  price: number;
  candles: Candle[];
  fundamentals?: QuantFundamentals;
  /** News sentiment score (-100..100). Backtests pass 0 (no honest history). */
  sentimentScore?: number;
}): QuantScoreResult {
  const { price, candles, fundamentals, sentimentScore = 0 } = input;

  const closes = candles.map((c) => c.close);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const trend = classifyTrend(price, s50, s200);
  const rsiVal = rsi(closes, 14);
  const { supports, resistances } = pivotLevels(candles);

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
  // Fundamentals ±35 (clamped)
  let fundamentalsUsed = false;
  let fundPts = 0;
  const fundFactors: { name: string; value: string; points: number }[] = [];
  if (fundamentals) {
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
    fundamentalsUsed = true;
    fundPts = Math.max(-35, Math.min(35, fundPts));
    score += fundPts;
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
      detail: fundamentalsUsed ? `${fundFactors.length} quality factors from SEC filings` : 'no EDGAR fundamentals available for this symbol',
    },
    ...(bearishVotes ? { bearishVotes } : {}),
  };

  return { score, action, confidence, calibrated, trend, rsi14: rsiVal, fundamentalsUsed, breakdown };
}
