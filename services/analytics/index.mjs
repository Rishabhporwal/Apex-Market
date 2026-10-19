#!/usr/bin/env node
/**
 * svc-analytics (port 8007) — compute plane per ADR-001.
 *
 * Plain .mjs port of:
 *  - /prediction/:symbol ← src/services/aiPredictionService.ts (deterministic
 *    multi-factor heuristic synthesis — NO external LLM calls anywhere in the
 *    original; confirmed it only consumes quote/candles/sentiment/financials/
 *    filings inputs).
 *  - POST /backtest      ← src/services/backtestService.ts (MA_CROSSOVER /
 *    RSI_REVERSION / MACD_MOMENTUM / SENTIMENT_BREAKOUT over candles, equity
 *    curve, trades, Sharpe/CAGR/drawdown) with the exact BacktestParams body
 *    parsing of src/app/api/backtest/route.ts.
 *
 * Data comes from sibling services via registry/SERVICES_JSON discovery:
 * market-data (quote + candles), news (/sentiment), research (/financials,
 * /filings). Technical indicators are computed locally via shared/technical.mjs
 * (exact port of technicalService.ts). TTL caches: candles 10min, sentiment 5min.
 */
import { startService, loadEnvLocal, TtlCache, httpClient } from '../shared/lib.mjs';
import { resolveService } from '../shared/discovery.mjs';
import { computeIndicators, getTechnicalSummary, calculateSMA } from '../shared/technical.mjs';
import { ensurePredictiveInsight } from '../shared/sentimentInsight.mjs';

loadEnvLocal();

const candlesCache = new TtlCache(10 * 60_000, 500, 'candles');  // same TTL as svc-market-data
const sentimentCache = new TtlCache(5 * 60_000, 200, 'sentiment'); // news headlines shift slowly

async function fetchJson(service, path, { span, timeoutMs = 25_000, method = 'GET', body = null, ctx = null } = {}) {
  const base = await resolveService(service);
  const res = await httpClient.fetch(`${base}${path}`, { method, body, span, timeoutMs, ctx });
  if (!res.ok) throw new Error(res.json?.error || `${service} ${path} -> ${res.status}`);
  return res.json;
}

async function getCandles(symbol, timeframe = '1y', interval = '1d', ctx = null) {
  const clean = String(symbol).trim().toUpperCase();
  return candlesCache.wrap(`${clean}|${timeframe}|${interval}`, async () => {
    const json = await fetchJson('market-data', `/candles/${encodeURIComponent(clean)}?timeframe=${encodeURIComponent(timeframe)}&interval=${encodeURIComponent(interval)}`, { span: 'analytics.market-data.candles', ctx });
    return json.candles || [];
  });
}

async function getSentiment(symbol, ctx = null) {
  const clean = String(symbol).trim().toUpperCase();
  return sentimentCache.wrap(clean, async () => {
    const raw = await fetchJson('news', `/sentiment/${encodeURIComponent(clean)}`, { span: 'analytics.news.sentiment', ctx });
    // svc-news predates predictiveInsight — enrich so downstream logic (and the
    // response shape) matches the monolith exactly.
    return ensurePredictiveInsight(raw);
  });
}

// ============================================================
// Port of aiPredictionService.ts — deterministic prediction
// ============================================================

async function generatePrediction(symbol, ctx = null) {
  const cleanSymbol = symbol.trim().toUpperCase();

  // Fetch data from all purpose-built services concurrently
  const [quote, candles, sentimentData, keyFin, overview, filings, transcripts] = await Promise.all([
    fetchJson('market-data', `/quote/${encodeURIComponent(cleanSymbol)}`, { span: 'analytics.market-data.quote', ctx }),
    getCandles(cleanSymbol, '1y', '1d', ctx),
    getSentiment(cleanSymbol, ctx),
    fetchJson('research', `/financials/${encodeURIComponent(cleanSymbol)}?section=key-metrics`, { span: 'analytics.research.keyFinancials', ctx }).catch(() => null),
    fetchJson('research', `/financials/${encodeURIComponent(cleanSymbol)}?section=overview`, { span: 'analytics.research.overview', ctx }).catch(() => null),
    fetchJson('research', `/filings/${encodeURIComponent(cleanSymbol)}?type=filings`, { span: 'analytics.research.filings', ctx }).catch(() => []),
    fetchJson('research', `/filings/${encodeURIComponent(cleanSymbol)}?type=transcripts`, { span: 'analytics.research.transcripts', ctx }).catch(() => []),
  ]);

  const currentPrice = quote.price || (candles.length > 0 ? candles[candles.length - 1].close : 100);
  const techSummary = getTechnicalSummary(cleanSymbol, candles);

  // 1. Analyze Dimension: Technical & Chart
  const technicalDimension = analyzeTechnicalDimension(techSummary, candles, currentPrice);

  // 2. Analyze Dimension: News & Sentiment
  const sentimentDimension = analyzeSentimentDimension(sentimentData);

  // 3. Analyze Dimension: Fundamentals & Valuation
  const fundamentalsDimension = analyzeFundamentalsDimension(keyFin, currentPrice);

  // 4. Analyze Dimension: SEC Filings & Earnings Call Tone
  const filingsDimension = analyzeFilingsDimension(filings, transcripts);

  // 5. Composite Score Calculation
  // Weights: Technical (35%), Sentiment (25%), Fundamentals (25%), Regulatory/SEC (15%)
  const compositeScore = Math.round(
    technicalDimension.score * 0.35 +
    sentimentDimension.score * 0.25 +
    fundamentalsDimension.score * 0.25 +
    filingsDimension.score * 0.15
  );

  // 6. Determine Master Recommendation
  let recommendation = 'HOLD';
  if (compositeScore >= 45) recommendation = 'STRONG_BUY';
  else if (compositeScore >= 18) recommendation = 'BUY';
  else if (compositeScore <= -45) recommendation = 'STRONG_SELL';
  else if (compositeScore <= -18) recommendation = 'SELL';

  // 7. Calculate Confluence & Confidence Score
  const verdicts = [technicalDimension.verdict, sentimentDimension.verdict, fundamentalsDimension.verdict, filingsDimension.verdict];
  const bullishAgreement = verdicts.filter((v) => v === 'BULLISH').length;
  const bearishAgreement = verdicts.filter((v) => v === 'BEARISH').length;
  const maxAgreement = Math.max(bullishAgreement, bearishAgreement);
  const confidenceScore = Math.min(95, Math.max(55, 50 + maxAgreement * 10 + Math.abs(compositeScore) * 0.25));

  // 8. Generate Precise Numerical Price Targets, Stop Loss & Key Levels
  const priceTargets = calculatePriceTargets(
    currentPrice,
    techSummary.supportLevels,
    techSummary.resistanceLevels,
    recommendation,
    keyFin?.targetMeanPrice
  );

  // 9. Generate Synthesis Rationale & Invalidation Criteria
  const { rationale, invalidation, executionSummary } = generateExecutiveSynthesis(
    cleanSymbol,
    recommendation,
    currentPrice,
    priceTargets,
    compositeScore,
    technicalDimension,
    sentimentDimension,
    fundamentalsDimension
  );

  return {
    symbol: cleanSymbol,
    companyName: overview?.name || quote.name || cleanSymbol,
    recommendation,
    confidenceScore: Math.round(confidenceScore),
    timeHorizon: '2 - 8 Weeks (Tactical Swing / Position Horizon)',
    synthesisRationale: rationale,
    priceTargets,
    dimensions: {
      technicalChart: technicalDimension,
      newsSentiment: sentimentDimension,
      fundamentalsValuation: fundamentalsDimension,
      secRegulatoryFilings: filingsDimension,
    },
    invalidationTrigger: invalidation,
    tradeExecutionSummary: executionSummary,
    generatedAt: Date.now(),
  };
}

// --- Dimension Analyzers ---

function analyzeTechnicalDimension(techSummary, candles, currentPrice) {
  let score = 0;
  const keyDrivers = [];

  // Trend analysis
  if (techSummary.trendLongTerm === 'BULLISH') {
    score += 35;
    keyDrivers.push('Primary long-term trend is bullish (Price > 50-day & 200-day SMAs).');
  } else if (techSummary.trendLongTerm === 'BEARISH') {
    score -= 35;
    keyDrivers.push('Primary long-term trend is bearish (Price below key moving averages).');
  }

  if (techSummary.trendShortTerm === 'BULLISH') {
    score += 25;
    keyDrivers.push('Short-term momentum aligned upward with 9/21 EMA stack.');
  } else if (techSummary.trendShortTerm === 'BEARISH') {
    score -= 25;
    keyDrivers.push('Short-term momentum under downward pressure with fast EMA death-cross.');
  }

  // RSI analysis
  if (techSummary.rsi14 < 35) {
    score += 20;
    keyDrivers.push(`RSI(14) sits in oversold territory at ${techSummary.rsi14.toFixed(1)}, signaling mean-reversion rebound potential.`);
  } else if (techSummary.rsi14 > 72) {
    score -= 20;
    keyDrivers.push(`RSI(14) is extended at ${techSummary.rsi14.toFixed(1)} (Overbought), indicating elevated risk of consolidation.`);
  } else {
    keyDrivers.push(`RSI(14) is balanced at ${techSummary.rsi14.toFixed(1)} within neutral expansion channel.`);
  }

  // MACD Cross
  if (techSummary.macdCross === 'BULLISH_CROSS') {
    score += 20;
    keyDrivers.push('Fresh bullish MACD signal crossover confirmed.');
  } else if (techSummary.macdCross === 'BEARISH_CROSS') {
    score -= 20;
    keyDrivers.push('Bearish MACD signal crossover confirmed.');
  }

  score = Math.max(-100, Math.min(100, score));

  let verdict = 'NEUTRAL';
  if (score >= 25) verdict = 'BULLISH';
  else if (score <= -25) verdict = 'BEARISH';

  const summary = verdict === 'BULLISH'
    ? `Technical structure is constructively positioned with bullish momentum alignment and firm support base.`
    : verdict === 'BEARISH'
    ? `Technical structure shows breakdown characteristics with resistance overhead and negative indicator momentum.`
    : `Technical indicators are in neutral equilibrium with choppy rangebound price action.`;

  return { score, verdict, summary, keyDrivers };
}

function analyzeSentimentDimension(sentimentData) {
  const rawScore = sentimentData.overallScore || 0; // -100 to +100
  const keyDrivers = [];

  if (rawScore >= 30) {
    keyDrivers.push(`Dominant positive financial media coverage (${sentimentData.bullishPercentage}% bullish polarity).`);
    keyDrivers.push(`Top catalysts: ${sentimentData.predictiveInsight.topCatalysts?.[0] || 'Strong revenue acceleration'}`);
  } else if (rawScore <= -30) {
    keyDrivers.push(`Defensive financial media coverage (${sentimentData.bearishPercentage}% bearish polarity).`);
    keyDrivers.push(`Risk factors: ${sentimentData.predictiveInsight.riskFactors?.[0] || 'Macro or regulatory scrutiny'}`);
  } else {
    keyDrivers.push(`Balanced sentiment flow with mixed market commentary.`);
  }

  let verdict = 'NEUTRAL';
  if (rawScore >= 20) verdict = 'BULLISH';
  else if (rawScore <= -20) verdict = 'BEARISH';

  return {
    score: rawScore,
    verdict,
    summary: sentimentData.predictiveInsight.rationale,
    keyDrivers,
  };
}

function analyzeFundamentalsDimension(keyFin, currentPrice) {
  let score = 15; // default moderate positive for established equities
  const keyDrivers = [];

  if (keyFin) {
    // P/E multiple
    if (keyFin.trailingPE && keyFin.trailingPE < 25) {
      score += 25;
      keyDrivers.push(`Attractive valuation: Trailing P/E of ${keyFin.trailingPE.toFixed(1)}x offers margin of safety.`);
    } else if (keyFin.trailingPE && keyFin.trailingPE > 65) {
      score -= 20;
      keyDrivers.push(`Premium multiple: Trailing P/E of ${keyFin.trailingPE.toFixed(1)}x requires flawless execution.`);
    }

    // Profit margins
    if (keyFin.profitMargin && keyFin.profitMargin > 0.18) {
      score += 25;
      keyDrivers.push(`High profitability: Net profit margin of ${(keyFin.profitMargin * 100).toFixed(1)}% highlights strong pricing power.`);
    }

    // Free Cash Flow
    if (keyFin.freeCashflow && keyFin.freeCashflow > 0) {
      score += 20;
      keyDrivers.push(`Robust cash generation: Positive Free Cash Flow provides strategic reinvestment liquidity.`);
    }

    // Wall Street target
    if (keyFin.targetMeanPrice && keyFin.targetMeanPrice > currentPrice) {
      const upside = ((keyFin.targetMeanPrice - currentPrice) / currentPrice) * 100;
      score += Math.min(30, upside);
      keyDrivers.push(`Wall Street consensus price target of $${keyFin.targetMeanPrice.toFixed(2)} implies +${upside.toFixed(1)}% upside.`);
    }
  } else {
    keyDrivers.push('Standard fundamental baseline applied.');
  }

  score = Math.max(-100, Math.min(100, score));

  let verdict = 'NEUTRAL';
  if (score >= 25) verdict = 'BULLISH';
  else if (score <= -25) verdict = 'BEARISH';

  const summary = verdict === 'BULLISH'
    ? `Strong fundamental profile anchored by operating profitability, positive cash generation, and analyst target headroom.`
    : verdict === 'BEARISH'
    ? `Valuation stretch or margin compression creates an unfavorable fundamental risk/reward profile.`
    : `Fundamentals are reasonably balanced with market expectations priced into the current multiple.`;

  return { score, verdict, summary, keyDrivers };
}

function analyzeFilingsDimension(filings, transcripts) {
  let score = 20;
  const keyDrivers = [];

  if (transcripts.length > 0) {
    const latest = transcripts[0];
    if (latest.revenueSurprisePercent && latest.revenueSurprisePercent > 0) {
      score += 25;
      keyDrivers.push(`Quarterly revenue exceeded consensus estimates by +${latest.revenueSurprisePercent.toFixed(1)}%.`);
    }
    if (latest.epsSurprisePercent && latest.epsSurprisePercent > 0) {
      score += 25;
      keyDrivers.push(`Quarterly EPS delivered a +${latest.epsSurprisePercent.toFixed(1)}% earnings surprise beat.`);
    }
    if (latest.positiveHighlights?.[0]) {
      keyDrivers.push(`Management highlights: ${latest.positiveHighlights[0]}`);
    }
  } else {
    keyDrivers.push('Regulatory filings verified in compliance with SEC reporting standards.');
  }

  score = Math.max(-100, Math.min(100, score));

  let verdict = 'NEUTRAL';
  if (score >= 25) verdict = 'BULLISH';
  else if (score <= -25) verdict = 'BEARISH';

  return {
    score,
    verdict,
    summary: `Regulatory filings and earnings conference transcripts reflect clean execution with positive earnings surprise history.`,
    keyDrivers,
  };
}

// --- Exact Mathematical Price Targets & Key Levels ---

function calculatePriceTargets(
  currentPrice,
  supports,
  resistances,
  recommendation,
  analystMean
) {
  // Determine realistic support and resistance anchors
  const s1 = supports.length > 0 ? supports[0] : Number((currentPrice * 0.96).toFixed(2));
  const s2 = supports.length > 1 ? supports[1] : Number((currentPrice * 0.92).toFixed(2));
  const s3 = supports.length > 2 ? supports[2] : Number((currentPrice * 0.88).toFixed(2));

  const r1 = resistances.length > 0 ? resistances[0] : Number((currentPrice * 1.05).toFixed(2));
  const r2 = resistances.length > 1 ? resistances[1] : Number((currentPrice * 1.11).toFixed(2));
  const r3 = resistances.length > 2 ? resistances[2] : Number((currentPrice * 1.20).toFixed(2));

  const isBullish = recommendation === 'STRONG_BUY' || recommendation === 'BUY';

  // Entry Zone
  const entryMin = isBullish ? Number((Math.min(currentPrice * 0.99, s1 * 1.01)).toFixed(2)) : Number((currentPrice * 0.98).toFixed(2));
  const entryMax = isBullish ? Number((currentPrice * 1.01).toFixed(2)) : Number((currentPrice * 1.02).toFixed(2));

  // Stop Loss (Strict Capital Preservation)
  const stopPrice = isBullish
    ? Number((s1 * 0.985).toFixed(2))
    : Number((r1 * 1.02).toFixed(2));
  const stopRiskPct = Math.abs(Number((((stopPrice - currentPrice) / currentPrice) * 100).toFixed(2)));

  // Targets
  const t1Price = isBullish
    ? Number((Math.max(r1, currentPrice * 1.045)).toFixed(2))
    : Number((Math.min(s1, currentPrice * 0.95)).toFixed(2));
  const t1Upside = Number((((t1Price - currentPrice) / currentPrice) * 100).toFixed(2));

  const t2Price = isBullish
    ? Number((Math.max(r2, analystMean || currentPrice * 1.12)).toFixed(2))
    : Number((Math.min(s2, currentPrice * 0.90)).toFixed(2));
  const t2Upside = Number((((t2Price - currentPrice) / currentPrice) * 100).toFixed(2));

  const t3Price = isBullish
    ? Number((Math.max(r3, t2Price * 1.08)).toFixed(2))
    : Number((Math.min(s3, currentPrice * 0.85)).toFixed(2));
  const t3Upside = Number((((t3Price - currentPrice) / currentPrice) * 100).toFixed(2));

  // Risk / Reward Ratio = Base Target Gain / Stop Loss Risk
  const rrRatio = stopRiskPct > 0 ? Number((Math.abs(t2Upside) / stopRiskPct).toFixed(2)) : 3.0;

  return {
    currentPrice: Number(currentPrice.toFixed(2)),
    entryZone: [entryMin, entryMax],
    target1: {
      price: t1Price,
      upsidePercent: t1Upside,
      label: isBullish ? 'Conservative Take-Profit (Resistance 1)' : 'Cover Partial Short',
    },
    target2: {
      price: t2Price,
      upsidePercent: t2Upside,
      label: isBullish ? 'Base Case Target (Catalyst Realization)' : 'Primary Downside Target',
    },
    target3: {
      price: t3Price,
      upsidePercent: t3Upside,
      label: isBullish ? 'Bullish Extension (Blue Sky Momentum)' : 'Macro Flush Target',
    },
    stopLoss: {
      price: stopPrice,
      riskPercent: stopRiskPct,
      rationale: isBullish
        ? `Placed 1.5% beneath Primary Support ($${s1}) to avoid market maker liquidity wicks.`
        : `Placed 2.0% above Overhead Resistance ($${r1}) to limit short squeeze risk.`,
    },
    riskRewardRatio: rrRatio,
    resistances: [
      { level: 'R1', price: r1, strength: 'MODERATE' },
      { level: 'R2', price: r2, strength: 'STRONG' },
      { level: 'R3', price: r3, strength: 'STRONG' },
    ],
    supports: [
      { level: 'S1', price: s1, strength: 'STRONG' },
      { level: 'S2', price: s2, strength: 'MODERATE' },
      { level: 'S3', price: s3, strength: 'STRONG' },
    ],
  };
}

// --- Executive Synthesis & Action Plan ---

function generateExecutiveSynthesis(
  symbol,
  rec,
  price,
  targets,
  score,
  tech,
  sentiment,
  fin
) {
  let rationale = '';
  let invalidation = '';
  let executionSummary = '';

  if (rec === 'STRONG_BUY' || rec === 'BUY') {
    rationale = `Our multi-factor institutional model synthesizes an authoritative ${rec.replace('_', ' ')} recommendation for ${symbol} with a composite score of +${score}/100. High-conviction bullish confluence is observed across: (1) Constructive technical structure with moving averages fanning upward, (2) Strong positive news sentiment velocity with active expansion catalysts, and (3) Resilient balance sheet metrics and cash generation supporting valuation expansion toward Base Target $${targets.target2.price}.`;
    invalidation = `A confirmed daily closing candle below Primary Support ($${targets.supports[0].price}) on above-average volume would invalidate the bullish thesis and trigger strict risk exit at Stop Loss $${targets.stopLoss.price}.`;
    executionSummary = `Accrue exposure within Entry Zone [$${targets.entryZone[0]}, $${targets.entryZone[1]}]. Scale out 40% at Target 1 ($${targets.target1.price}, +${targets.target1.upsidePercent}%), trail stop to breakeven, and let remaining 60% run to Base Target 2 ($${targets.target2.price}, +${targets.target2.upsidePercent}%). Implied Risk/Reward: 1 : ${targets.riskRewardRatio}.`;
  } else if (rec === 'STRONG_SELL' || rec === 'SELL') {
    rationale = `Our multi-factor model generates a defensive ${rec.replace('_', ' ')} rating for ${symbol} with a composite score of ${score}/100. Bearish confluence is detected from heavy overhead resistance, deteriorating news sentiment, and valuation sensitivity under prevailing market rate conditions.`;
    invalidation = `A decisive breakout and sustained close above Overhead Resistance ($${targets.resistances[0].price}) would invalidate the bearish bias and indicate short-covering momentum.`;
    executionSummary = `Reduce or hedge long exposure. For active tactical traders, initiate short or hedge on rallies toward $${targets.entryZone[1]}, targeting downside support targets at $${targets.target1.price} and $${targets.target2.price} with a stop placed strictly at $${targets.stopLoss.price}.`;
  } else {
    rationale = `Our quantitative synthesis suggests a HOLD / NEUTRAL stance for ${symbol} (Score: ${score}/100). The asset is currently consolidating in a defined equilibrium channel between Support S1 ($${targets.supports[0].price}) and Resistance R1 ($${targets.resistances[0].price}). Bullish fundamental catalysts are currently balanced by technical resistance.`;
    invalidation = `A breakout above $${targets.resistances[0].price} triggers a BUY continuation, whereas a breakdown below $${targets.supports[0].price} triggers a defensive downgrade.`;
    executionSummary = `Hold existing core allocations. Await decisive breakout confirmation before deploying incremental fresh capital. Key pivot levels: S1 ($${targets.supports[0].price}) and R1 ($${targets.resistances[0].price}).`;
  }

  return { rationale, invalidation, executionSummary };
}

// ============================================================
// Port of backtestService.ts
// ============================================================

async function runBacktest(params, ctx = null) {
  const symbol = params.symbol.toUpperCase();
  const candles = await getCandles(symbol, params.timeframe, '1d', ctx);

  if (!candles || candles.length < 30) {
    throw new Error(`Insufficient historical data available for ${symbol} over ${params.timeframe}`);
  }

  // Also fetch SPY benchmark over the same timeframe for alpha comparison
  const spyCandles = await getCandles('SPY', params.timeframe, '1d', ctx);

  return simulateStrategy(params, candles, spyCandles);
}

function simulateStrategy(params, candles, spyCandles) {
  const initialCapital = params.initialCapital || 10000;
  let cash = initialCapital;
  let shares = 0;
  let entryPrice = 0;
  let entryDate = '';

  const trades = [];
  const equityCurve = [];

  const closes = candles.map((c) => c.close);
  const indicatorData = computeIndicators(candles);

  const fastPeriod = params.fastPeriod || (params.strategy === 'MA_CROSSOVER' ? 50 : 9);
  const slowPeriod = params.slowPeriod || (params.strategy === 'MA_CROSSOVER' ? 200 : 21);
  const rsiOversold = params.rsiOversold || 30;
  const rsiOverbought = params.rsiOverbought || 70;
  const stopLossPct = params.stopLossPercent ? params.stopLossPercent / 100 : undefined;
  const takeProfitPct = params.takeProfitPercent ? params.takeProfitPercent / 100 : undefined;

  // Strategy Fast & Slow MAs
  const fastMA = calculateSMA(closes, fastPeriod);
  const slowMA = calculateSMA(closes, slowPeriod);

  // Track SPY benchmark normalization
  const initialSpyClose = spyCandles.length > 0 ? spyCandles[0].close : 1;

  let peakValue = initialCapital;
  let maxDrawdown = 0;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const currentPrice = candle.close;
    const date = candle.time;

    // Benchmark normalized value
    const spyMatch = spyCandles.find((s) => s.time === date) || spyCandles[Math.min(i, spyCandles.length - 1)];
    const benchmarkValue = spyMatch ? (spyMatch.close / initialSpyClose) * initialCapital : initialCapital;

    // Check current position exit triggers (Stop Loss or Take Profit)
    if (shares > 0) {
      const gainLossPct = (currentPrice - entryPrice) / entryPrice;

      let shouldExit = false;
      let exitReason = 'SIGNAL';

      if (stopLossPct && gainLossPct <= -stopLossPct) {
        shouldExit = true;
        exitReason = 'STOP_LOSS';
      } else if (takeProfitPct && gainLossPct >= takeProfitPct) {
        shouldExit = true;
        exitReason = 'TAKE_PROFIT';
      }

      if (shouldExit) {
        const proceeds = shares * currentPrice;
        const pnl = proceeds - shares * entryPrice;
        cash += proceeds;

        trades.push({
          id: `trade-${trades.length + 1}`,
          type: 'SELL',
          date,
          price: currentPrice,
          shares,
          amount: proceeds,
          returnPercent: Number((gainLossPct * 100).toFixed(2)),
          pnl: Number(pnl.toFixed(2)),
          exitReason,
        });

        shares = 0;
        entryPrice = 0;
      }
    }

    // Check Strategy Signals
    let buySignal = false;
    let sellSignal = false;

    switch (params.strategy) {
      case 'MA_CROSSOVER': {
        const prevFast = fastMA[i - 1];
        const currFast = fastMA[i];
        const prevSlow = slowMA[i - 1];
        const currSlow = slowMA[i];

        if (prevFast !== null && currFast !== null && prevSlow !== null && currSlow !== null) {
          if (prevFast <= prevSlow && currFast > currSlow) {
            buySignal = true;
          } else if (prevFast >= prevSlow && currFast < currSlow) {
            sellSignal = true;
          }
        }
        break;
      }
      case 'RSI_REVERSION': {
        const prevRSI = indicatorData[i - 1]?.rsi14;
        const currRSI = indicatorData[i]?.rsi14;
        if (prevRSI !== undefined && currRSI !== undefined) {
          if (prevRSI <= rsiOversold && currRSI > rsiOversold) {
            buySignal = true;
          } else if (currRSI >= rsiOverbought) {
            sellSignal = true;
          }
        }
        break;
      }
      case 'MACD_MOMENTUM': {
        const prevHist = indicatorData[i - 1]?.macd?.histogram;
        const currHist = indicatorData[i]?.macd?.histogram;
        if (prevHist !== undefined && currHist !== undefined) {
          if (prevHist <= 0 && currHist > 0) {
            buySignal = true;
          } else if (prevHist >= 0 && currHist < 0) {
            sellSignal = true;
          }
        }
        break;
      }
      case 'SENTIMENT_BREAKOUT': {
        const currRSI = indicatorData[i]?.rsi14 ?? 50;
        const currSMA20 = indicatorData[i]?.sma20 ?? currentPrice;
        if (currentPrice > currSMA20 && currRSI > 45 && currRSI < 65) {
          buySignal = true;
        } else if (currentPrice < currSMA20 || currRSI > 75) {
          sellSignal = true;
        }
        break;
      }
    }

    // Execute Buy Signal
    if (buySignal && shares === 0 && cash > 100) {
      const affordableShares = Math.floor(cash / currentPrice);
      if (affordableShares > 0) {
        shares = affordableShares;
        entryPrice = currentPrice;
        entryDate = date;
        const totalCost = shares * currentPrice;
        cash -= totalCost;

        trades.push({
          id: `trade-${trades.length + 1}`,
          type: 'BUY',
          date,
          price: currentPrice,
          shares,
          amount: totalCost,
        });
      }
    }

    // Execute Sell Signal
    if (sellSignal && shares > 0) {
      const proceeds = shares * currentPrice;
      const gainLossPct = (currentPrice - entryPrice) / entryPrice;
      const pnl = proceeds - shares * entryPrice;
      cash += proceeds;

      trades.push({
        id: `trade-${trades.length + 1}`,
        type: 'SELL',
        date,
        price: currentPrice,
        shares,
        amount: proceeds,
        returnPercent: Number((gainLossPct * 100).toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
        exitReason: 'SIGNAL',
      });

      shares = 0;
      entryPrice = 0;
    }

    // Record daily equity
    const currentEquity = cash + shares * currentPrice;
    if (currentEquity > peakValue) {
      peakValue = currentEquity;
    }
    const dd = ((peakValue - currentEquity) / peakValue) * 100;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
    }

    equityCurve.push({
      date,
      portfolioValue: Math.round(currentEquity),
      benchmarkValue: Math.round(benchmarkValue),
      drawdownPercent: Number(dd.toFixed(2)),
    });
  }

  // Close any open position at end of backtest period
  if (shares > 0) {
    const finalPrice = candles[candles.length - 1].close;
    const finalDate = candles[candles.length - 1].time;
    const proceeds = shares * finalPrice;
    const gainLossPct = (finalPrice - entryPrice) / entryPrice;
    const pnl = proceeds - shares * entryPrice;
    cash += proceeds;

    trades.push({
      id: `trade-${trades.length + 1}`,
      type: 'SELL',
      date: finalDate,
      price: finalPrice,
      shares,
      amount: proceeds,
      returnPercent: Number((gainLossPct * 100).toFixed(2)),
      pnl: Number(pnl.toFixed(2)),
      exitReason: 'END_OF_PERIOD',
    });
  }

  const finalPortfolioValue = cash;
  const totalReturnPercent = ((finalPortfolioValue - initialCapital) / initialCapital) * 100;

  // SPY benchmark return
  const finalSpyClose = spyCandles.length > 0 ? spyCandles[spyCandles.length - 1].close : initialSpyClose;
  const benchmarkReturnPercent = ((finalSpyClose - initialSpyClose) / initialSpyClose) * 100;

  // Trade stats
  const sellTrades = trades.filter((t) => t.type === 'SELL');
  const winningTrades = sellTrades.filter((t) => (t.pnl || 0) > 0).length;
  const losingTrades = sellTrades.filter((t) => (t.pnl || 0) < 0).length;
  const winRatePercent = sellTrades.length > 0 ? (winningTrades / sellTrades.length) * 100 : 0;

  const grossProfit = sellTrades.filter((t) => (t.pnl || 0) > 0).reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossLoss = Math.abs(sellTrades.filter((t) => (t.pnl || 0) < 0).reduce((sum, t) => sum + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 1;

  const avgTradeReturn =
    sellTrades.length > 0
      ? sellTrades.reduce((acc, t) => acc + (t.returnPercent || 0), 0) / sellTrades.length
      : 0;

  // Annualized return (CAGR)
  const days = candles.length;
  const years = Math.max(0.1, days / 252);
  const cagr = (Math.pow(finalPortfolioValue / initialCapital, 1 / years) - 1) * 100;

  // Annualized Sharpe Ratio estimate
  const dailyReturns = [];
  for (let k = 1; k < equityCurve.length; k++) {
    const prev = equityCurve[k - 1].portfolioValue;
    const curr = equityCurve[k].portfolioValue;
    dailyReturns.push((curr - prev) / prev);
  }
  const meanDaily = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const variance =
    dailyReturns.length > 1
      ? dailyReturns.reduce((a, b) => a + Math.pow(b - meanDaily, 2), 0) / (dailyReturns.length - 1)
      : 0.0001;
  const stdDevDaily = Math.sqrt(variance);
  const riskFreeDaily = 0.04 / 252; // 4% risk-free rate
  const sharpeRatio = stdDevDaily > 0 ? ((meanDaily - riskFreeDaily) / stdDevDaily) * Math.sqrt(252) : 0;

  return {
    params,
    totalReturnPercent: Number(totalReturnPercent.toFixed(2)),
    benchmarkReturnPercent: Number(benchmarkReturnPercent.toFixed(2)),
    cagr: Number(cagr.toFixed(2)),
    sharpeRatio: Number(sharpeRatio.toFixed(2)),
    maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
    totalTrades: sellTrades.length,
    winningTrades,
    losingTrades,
    winRatePercent: Number(winRatePercent.toFixed(1)),
    profitFactor: Number(profitFactor.toFixed(2)),
    averageTradeReturnPercent: Number(avgTradeReturn.toFixed(2)),
    equityCurve,
    trades,
  };
}

// ---- HTTP surface ----

const { app, listen, close } = await startService({
  name: 'svc-analytics',
  port: Number(process.env.PORT || 8007),
  healthDeps: async () => ({
    ok: true,
    candlesCache: candlesCache.size,
    sentimentCache: sentimentCache.size,
  }),
});

app.get('/prediction/:symbol', async (req, reply) => {
  try {
    return await generatePrediction(String(req.params.symbol || '').trim().toUpperCase(), req.traceCtx);
  } catch (err) {
    return reply.status(502).send({ error: err?.message || 'AI prediction synthesis failed' });
  }
});

app.post('/backtest', async (req, reply) => {
  try {
    const body = req.body || {};

    if (!body.symbol) {
      return reply.status(400).send({ error: 'Ticker symbol is required' });
    }

    // Exact parsing of src/app/api/backtest/route.ts
    const defaultParams = {
      symbol: String(body.symbol).toUpperCase(),
      strategy: body.strategy || 'MA_CROSSOVER',
      initialCapital: Number(body.initialCapital) || 10000,
      timeframe: body.timeframe || '1y',
      fastPeriod: body.fastPeriod ? Number(body.fastPeriod) : undefined,
      slowPeriod: body.slowPeriod ? Number(body.slowPeriod) : undefined,
      rsiOverbought: body.rsiOverbought ? Number(body.rsiOverbought) : undefined,
      rsiOversold: body.rsiOversold ? Number(body.rsiOversold) : undefined,
      stopLossPercent: body.stopLossPercent ? Number(body.stopLossPercent) : undefined,
      takeProfitPercent: body.takeProfitPercent ? Number(body.takeProfitPercent) : undefined,
    };

    return await runBacktest(defaultParams, req.traceCtx);
  } catch (err) {
    return reply.status(500).send({ error: err?.message || 'Backtesting service failed' });
  }
});

await listen();

process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
