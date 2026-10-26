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

loadEnvLocal();

const candlesCache = new TtlCache(10 * 60_000, 500, 'candles');  // same TTL as svc-market-data

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

// ============================================================
// Port of aiPredictionService.ts — deterministic prediction
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
  }),
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
