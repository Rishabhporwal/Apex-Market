/**
 * svc-verdict quant core — EXACT port of src/services/quantEngine.ts.
 * Pure functions only: no fetches, no globals, no Date.now().
 * Single source of truth requirement: scoring must match the monolith's
 * backtester bit-for-bit (trend ±25, RSI ±15, news ±25 clamped /4,
 * fundamentals ±35 clamped, BUY>=35, SELL needs 2 bearish votes,
 * confidence min(95, 45+|score|/2)).
 */

// ---- Indicator math ----
export function sma(values, period) {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes, period = 14) {
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

// ---- Trend classification ----
export function classifyTrend(price, sma50, sma200) {
  if (sma50 && sma200) {
    if (price > sma50 && sma50 > sma200) return 'up';
    if (price < sma50 && sma50 < sma200) return 'down';
  }
  return 'sideways';
}

// ---- The core scoring function (mirrors aiVerdictService exactly) ----
export function scoreVerdict(input) {
  const { price, candles, fundamentals, sentimentScore = 0 } = input;

  const closes = candles.map((c) => c.close);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const trend = classifyTrend(price, s50, s200);
  const rsiVal = rsi(closes, 14);

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

  let action;
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
