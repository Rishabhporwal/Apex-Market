import { Candle } from '@/types';

export interface LevelsResult {
  price: number;
  supports: number[];
  resistances: number[];
  week52High: number;
  week52Low: number;
  sma20?: number;
  sma50?: number;
  sma200?: number;
  rsi14?: number;
  atr14?: number;
}

export interface StopAndTargets {
  stopLoss?: number;
  target1?: number;
  target2?: number;
}

const PIVOT_WINDOW = 5; // bars on each side of a fractal pivot
const DEDUP_PCT = 0.005; // levels within 0.5% of each other collapse
const MAX_LEVELS = 3;

function r2(n: number): number {
  return Number(n.toFixed(2));
}

/** Simple moving average of the last `period` values, or undefined. */
export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return r2(sum / period);
}

/** Wilder's RSI-14 on closes, latest value, or undefined. */
export function rsi(closes: number[], period = 14): number | undefined {
  if (closes.length <= period) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rs = (g: number, l: number) => (l === 0 ? 100 : g / l);
  let value = 100 - 100 / (1 + rs(avgGain, avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    value = 100 - 100 / (1 + rs(avgGain, avgLoss));
  }
  return r2(value);
}

/** Wilder's ATR-14 (latest value), or undefined. */
export function atr(candles: Candle[], period = 14): number | undefined {
  if (candles.length < period + 1) return undefined;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
  }
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return r2(a);
}

/**
 * Fractal pivot detection: a bar is a pivot high (resp. low) when its high
 * (resp. low) is strictly the extreme of the surrounding PIVOT_WINDOW bars
 * on each side.
 */
function findPivots(candles: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  const w = PIVOT_WINDOW;
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
  return { highs, lows };
}

/** Keep the first value of each cluster whose members are within 0.5% of it. */
function dedup(levels: number[]): number[] {
  const out: number[] = [];
  for (const lvl of levels) {
    if (!out.some((kept) => Math.abs(lvl - kept) / kept < DEDUP_PCT)) out.push(lvl);
  }
  return out;
}

/**
 * Pure deterministic level engine over daily candles.
 * Returns the nearest 3 supports below and 3 resistances above the latest close,
 * 52-week range, SMA 20/50/200, RSI-14 and ATR-14 — all rounded to 2dp.
 */
export function computeLevels(candles: Candle[]): LevelsResult {
  if (!candles || candles.length === 0) {
    throw new Error('computeLevels requires at least one candle');
  }
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const { highs, lows } = findPivots(candles);

  const allRes = dedup([...highs, ...candles.map((c) => c.high)].sort((a, b) => a - b));
  const allSup = dedup([...lows, ...candles.map((c) => c.low)].sort((a, b) => b - a));

  const resistances = allRes.filter((v) => v > price).slice(0, MAX_LEVELS).map(r2);
  const supports = allSup.filter((v) => v < price).slice(0, MAX_LEVELS).map(r2);

  const lookback = candles.slice(-252);
  const week52High = r2(Math.max(...lookback.map((c) => c.high)));
  const week52Low = r2(Math.min(...lookback.map((c) => c.low)));

  return {
    price: r2(price),
    supports,
    resistances,
    week52High,
    week52Low,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    rsi14: rsi(closes),
    atr14: atr(candles),
  };
}

/**
 * Trade levels for a BUY (mirrored for SELL):
 *  - stop  = min(nearest support cluster, price - 2*ATR) for BUY
 *  - t1    = nearest resistance beyond price + 1*ATR
 *  - t2    = next resistance beyond t1, or price + 3*ATR as fallback
 */
export function getStopLossAndTargets(
  candles: Candle[],
  action: 'BUY' | 'SELL' | 'HOLD' | 'NEUTRAL'
): StopAndTargets {
  if (!candles || candles.length === 0) return {};
  const levels = computeLevels(candles);
  const { price, supports, resistances, atr14 } = levels;
  if (!atr14) return {};

  const a = atr14;
  if (action === 'BUY') {
    const nearestSupport = supports.length ? Math.max(...supports) : undefined;
    const stop = Math.min(nearestSupport ?? price - 2 * a, price - 2 * a);
    const t1 = resistances.length
      ? Math.min(resistances[0] + a, price + 3 * a)
      : price + 2 * a;
    const nextRes = resistances.find((r) => r > t1);
    const t2 = nextRes !== undefined ? nextRes + a : price + 3 * a;
    return { stopLoss: r2(stop), target1: r2(t1), target2: r2(t2) };
  }

  if (action === 'SELL') {
    const nearestRes = resistances.length ? Math.min(...resistances) : undefined;
    const stop = Math.max(nearestRes ?? price + 2 * a, price + 2 * a);
    const t1 = supports.length
      ? Math.max(supports[0] - a, price - 3 * a)
      : price - 2 * a;
    const nextSup = supports.find((s) => s < t1);
    const t2 = nextSup !== undefined ? nextSup - a : price - 3 * a;
    return { stopLoss: r2(stop), target1: r2(t1), target2: r2(t2) };
  }

  return {};
}
