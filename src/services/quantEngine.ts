/**
 * Quant core — the deterministic scoring engine of the AI Verdict, extracted
 * so the backtester (scripts/backtest-verdicts.mjs) runs the EXACT same logic
 * as the live verdict. No drift between what we show and what we measured.
 *
 * Pure functions only: no fetches, no globals, no Date.now().
 */
import type { Candle } from '@/types';

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

export interface QuantScoreResult {
  score: number; // -100..100
  action: VerdictAction;
  confidence: number; // 0..100
  trend: Trend;
  rsi14?: number;
  fundamentalsUsed: boolean;
}

// ---- Indicator math (duplicated minimal implementations; kept in lockstep with levelsService) ----

export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes: number[], period = 14): number | undefined {
  if (closes.length < period + 1) return undefined;
  let gains = 0;
  let losses = 0;
  const window = closes.slice(-(period + 1));
  for (let i = 1; i < window.length; i++) {
    const diff = window[i] - window[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
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
  if (trend === 'up') score += 25;
  else if (trend === 'down') score -= 25;
  // RSI position ±15
  if (rsiVal !== undefined) {
    if (rsiVal < 30) score += 15;
    else if (rsiVal < 45) score += 7;
    else if (rsiVal > 70) score -= 15;
    else if (rsiVal > 55) score -= 7;
  }
  // News sentiment ±25 (clamped)
  score += Math.max(-25, Math.min(25, sentimentScore / 4));
  // Fundamentals ±35 (clamped)
  let fundamentalsUsed = false;
  if (fundamentals) {
    let f = 0;
    if (fundamentals.revenueGrowthYoY !== undefined) f += fundamentals.revenueGrowthYoY > 10 ? 12 : fundamentals.revenueGrowthYoY > 0 ? 6 : fundamentals.revenueGrowthYoY > -10 ? -6 : -12;
    if (fundamentals.netMargin !== undefined) f += fundamentals.netMargin > 20 ? 9 : fundamentals.netMargin > 5 ? 5 : fundamentals.netMargin > 0 ? 0 : -9;
    if (fundamentals.roe !== undefined) f += fundamentals.roe > 20 ? 8 : fundamentals.roe > 10 ? 4 : fundamentals.roe > 0 ? 0 : -8;
    if (fundamentals.peRatio !== undefined) f += fundamentals.peRatio > 0 && fundamentals.peRatio < 25 ? 6 : fundamentals.peRatio >= 25 && fundamentals.peRatio <= 60 ? 0 : -6;
    fundamentalsUsed = true;
    score += Math.max(-35, Math.min(35, f));
  }

  score = Math.round(Math.max(-100, Math.min(100, score)));

  let action: VerdictAction;
  if (score >= 35) action = 'BUY';
  else if (score >= 15) action = 'HOLD'; // bullish lean — summary text conveys it
  else if (score > -15) action = 'HOLD';
  else {
    // SELL requires confirmation: a bare low score is frequently a temporary
    // dip in a structurally sound company (value traps). Demand at least TWO
    // independent bearish confirmations from {trend, fundamentals, momentum}.
    let bearishVotes = 0;
    if (trend === 'down') bearishVotes++;
    if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) bearishVotes++;
    if (rsiVal !== undefined && rsiVal > 70) bearishVotes++; // momentum exhaustion
    action = bearishVotes >= 2 ? 'SELL' : 'HOLD';
  }

  const confidence = Math.round(Math.min(95, 45 + Math.abs(score) / 2));

  return { score, action, confidence, trend, rsi14: rsiVal, fundamentalsUsed };
}
