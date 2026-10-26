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
  const fundFactors = [];
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

  const confidence = Math.round(Math.min(95, 45 + Math.abs(score) / 2));

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
      detail: fundamentalsUsed ? `${fundFactors.length} quality factors from SEC filings` : 'no EDGAR fundamentals available for this symbol',
    },
    ...(bearishVotes ? { bearishVotes } : {}),
  };

  return { score, action, confidence, trend, rsi14: rsiVal, fundamentalsUsed, breakdown };
}
