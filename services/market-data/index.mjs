#!/usr/bin/env node
/**
 * svc-market-data (port 8001) — quotes, candles, indices per ADR-001.
 * Ported from src/services/marketDataService.ts: yahoo-finance2 integration,
 * TTL caches (quotes 60s, candles 10min) with stale-on-error fallback.
 */
import { startService, loadEnvLocal, TtlCache } from '../shared/lib.mjs';

loadEnvLocal();
const { default: YahooFinance } = await import('yahoo-finance2');
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const quoteCache = new TtlCache(60_000, 1_000, 'quotes'); // 60s — prices move fast
const candlesCache = new TtlCache(10 * 60_000, 500, 'candles'); // 10min — daily bars barely move intraday

function toQuote(q, cleanSymbol) {
  return {
    symbol: cleanSymbol,
    name: q.shortName || q.longName || cleanSymbol,
    price: q.regularMarketPrice || 0,
    change: q.regularMarketChange || 0,
    changePercent: q.regularMarketChangePercent || 0,
    open: q.regularMarketOpen || q.regularMarketPrice || 0,
    high: q.regularMarketDayHigh || q.regularMarketPrice || 0,
    low: q.regularMarketDayLow || q.regularMarketPrice || 0,
    previousClose: q.regularMarketPreviousClose || q.regularMarketPrice || 0,
    volume: q.regularMarketVolume || 0,
    avgVolume: q.averageDailyVolume3Month || q.regularMarketVolume || 0,
    marketCap: q.marketCap || 0,
    peRatio: q.trailingPE || undefined,
    week52High: q.fiftyTwoWeekHigh || 0,
    week52Low: q.fiftyTwoWeekLow || 0,
    currency: q.currency || 'USD',
    exchange: q.exchange || 'NASDAQ',
    marketState: q.marketState || 'CLOSED',
    timestamp: Date.now(),
  };
}

async function getQuote(symbol) {
  const cleanSymbol = String(symbol).trim().toUpperCase();
  return quoteCache.wrap(cleanSymbol, async () => {
    try {
      const q = await yf.quote(cleanSymbol);
      return toQuote(q, cleanSymbol);
    } catch (error) {
      throw new Error(`Unable to fetch quote for ${symbol}`);
    }
  });
}

const TIMEFRAMES = ['1d', '5d', '1mo', '6mo', '1y', '2y', '5y'];
const INTERVALS = ['1m', '5m', '15m', '1h', '1d', '1wk'];

function period1For(timeframe) {
  const now = new Date();
  const period1 = new Date();
  switch (timeframe) {
    case '1d': period1.setDate(now.getDate() - 2); break;
    case '5d': period1.setDate(now.getDate() - 7); break;
    case '1mo': period1.setMonth(now.getMonth() - 1); break;
    case '6mo': period1.setMonth(now.getMonth() - 6); break;
    case '2y': period1.setFullYear(now.getFullYear() - 2); break;
    case '5y': period1.setFullYear(now.getFullYear() - 5); break;
    default: period1.setFullYear(now.getFullYear() - 1);
  }
  return period1.toISOString().split('T')[0];
}

async function getHistoricalCandles(symbol, timeframe = '1y', interval = '1d') {
  const cleanSymbol = String(symbol).trim().toUpperCase();
  return candlesCache.wrap(`${cleanSymbol}|${timeframe}|${interval}`, async () => {
    try {
      const chartResult = await yf.chart(cleanSymbol, { period1: period1For(timeframe), interval });
      const quotes = chartResult.quotes || [];
      return quotes
        .filter((q) => q.open !== null && q.close !== null && q.high !== null && q.low !== null)
        .map((q) => ({
          time: new Date(q.date).toISOString().split('T')[0],
          open: Number((q.open ?? 0).toFixed(2)),
          high: Number((q.high ?? 0).toFixed(2)),
          low: Number((q.low ?? 0).toFixed(2)),
          close: Number((q.close ?? 0).toFixed(2)),
          volume: q.volume || 0,
        }));
    } catch (error) {
      return [];
    }
  });
}

async function getMarketIndices() {
  const indices = ['^GSPC', '^IXIC', '^DJI', '^RUT'];
  const results = await Promise.allSettled(indices.map((s) => getQuote(s)));
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// ---- HTTP surface ----
const { app, listen, close } = await startService({
  name: 'svc-market-data',
  port: Number(process.env.PORT || 8001),
  healthDeps: async () => ({ ok: true, quoteCache: quoteCache.size, candlesCache: candlesCache.size }),
});

app.get('/quote/:symbol', async (req, reply) => {
  try {
    return await getQuote(req.params.symbol);
  } catch (err) {
    return reply.status(502).send({ error: err.message });
  }
});

app.get('/candles/:symbol', async (req, reply) => {
  const timeframe = String(req.query.timeframe || '1y');
  const interval = String(req.query.interval || '1d');
  if (!TIMEFRAMES.includes(timeframe) || !INTERVALS.includes(interval)) {
    return reply.status(400).send({ error: `invalid timeframe/interval (timeframes: ${TIMEFRAMES.join(',')}, intervals: ${INTERVALS.join(',')})` });
  }
  const candles = await getHistoricalCandles(req.params.symbol, timeframe, interval);
  return { symbol: String(req.params.symbol).trim().toUpperCase(), timeframe, interval, count: candles.length, candles };
});

app.get('/indices', async () => {
  const quotes = await getMarketIndices();
  return { indices: quotes };
});

await listen();
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
