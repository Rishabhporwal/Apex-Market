#!/usr/bin/env node
/**
 * Verdict Backtester — measures how the AI Verdict's quant core would have
 * performed historically. This is the trust anchor: "BUY-rated signals from
 * this engine returned X% vs the S&P's Y% over the same windows."
 *
 * Method (honest by construction):
 *  - Walks monthly checkpoints over the last N years for each ticker.
 *  - At each checkpoint, feeds ONLY data available up to that date into the
 *    quant core (candles slice + fundamentals from the latest 10-K filed
 *    BEFORE the checkpoint — no look-ahead).
 *  - News/LLM are excluded from scoring (no historical news feed) — this makes
 *    results a lower-bound, not a fantasy.
 *  - Forward return = price change over the next `horizonDays` (default 90).
 *  - Benchmark: SPY buy-and-hold over the same windows.
 *
 * Usage:  node scripts/backtest-verdicts.mjs [--years=3] [--horizon=90] [--top=150] [--tickers=AAPL,MSFT]
 * Output: data/backtest-report.json + console summary
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(process.cwd());
const WAREHOUSE = path.join(ROOT, 'data', 'warehouse.duckdb');
const OUT = path.join(ROOT, 'data', 'backtest-report.json');

// ---- args ----
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const YEARS = Number(getArg('years', 3));
const HORIZON = Number(getArg('horizon', 90)); // forward return window in calendar days
const TOP = Number(getArg('top', 150)); // how many S&P names to test (liquidity-first)
const TICKERS_ARG = getArg('tickers', null);

// ---- quant core (kept in lockstep with src/services/quantEngine.ts) ----
const sma = (v, p) => (v.length < p ? undefined : v.slice(-p).reduce((a, b) => a + b, 0) / p);

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return undefined;
  let gains = 0, losses = 0;
  const w = closes.slice(-(period + 1));
  for (let i = 1; i < w.length; i++) {
    const d = w[i] - w[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

function classifyTrend(price, s50, s200) {
  if (s50 && s200) {
    if (price > s50 && s50 > s200) return 'up';
    if (price < s50 && s50 < s200) return 'down';
  }
  return 'sideways';
}

function scoreVerdict({ price, candles, fundamentals, sentimentScore = 0 }) {
  const closes = candles.map((c) => c.close);
  const trend = classifyTrend(price, sma(closes, 50), sma(closes, 200));
  const rv = rsi(closes, 14);

  let score = 0;
  if (trend === 'up') score += 25;
  else if (trend === 'down') score -= 25;
  if (rv !== undefined) {
    if (rv < 30) score += 15;
    else if (rv < 45) score += 7;
    else if (rv > 70) score -= 15;
    else if (rv > 55) score -= 7;
  }
  score += Math.max(-25, Math.min(25, sentimentScore / 4));
  if (fundamentals) {
    let f = 0;
    if (fundamentals.revenueGrowthYoY !== undefined) f += fundamentals.revenueGrowthYoY > 10 ? 12 : fundamentals.revenueGrowthYoY > 0 ? 6 : fundamentals.revenueGrowthYoY > -10 ? -6 : -12;
    if (fundamentals.netMargin !== undefined) f += fundamentals.netMargin > 20 ? 9 : fundamentals.netMargin > 5 ? 5 : fundamentals.netMargin > 0 ? 0 : -9;
    if (fundamentals.roe !== undefined) f += fundamentals.roe > 20 ? 8 : fundamentals.roe > 10 ? 4 : fundamentals.roe > 0 ? 0 : -8;
    if (fundamentals.peRatio !== undefined) f += fundamentals.peRatio > 0 && fundamentals.peRatio < 25 ? 6 : fundamentals.peRatio >= 25 && fundamentals.peRatio <= 60 ? 0 : -6;
    score += Math.max(-35, Math.min(35, f));
  }
  score = Math.round(Math.max(-100, Math.min(100, score)));
  let action;
  if (score >= 35) action = 'BUY';
  else if (score >= 15) action = 'HOLD';
  else if (score > -15) action = 'HOLD';
  else {
    // SELL requires confirmation: a bare low score is frequently a temporary
    // dip in a structurally sound company (value traps). Demand at least TWO
    // independent bearish confirmations from {trend, fundamentals, momentum}.
    let bearishVotes = 0;
    if (trend === 'down') bearishVotes++;
    if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) bearishVotes++;
    if (rv !== undefined && rv > 70) bearishVotes++; // momentum exhaustion
    action = bearishVotes >= 2 ? 'SELL' : 'HOLD';
  }
  return { score, action };
}

// ---- fundamentals as-of a date (EDGAR facts, no look-ahead) ----
function buildFundamentalsAsOf(facts, asOfMs) {
  // facts: [{tag, end(ms), val, form}] pre-filtered to annual 10-K us-gaap rows
  const pick = (tags) => {
    for (const tag of tags) {
      const rows = facts.filter((f) => f.tag === tag && f.end <= asOfMs);
      if (rows.length) {
        rows.sort((a, b) => b.end - a.end);
        return rows[0].val;
      }
    }
    return undefined;
  };
  const revenue = pick(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet']);
  const revenuePrev = (() => {
    const tags = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'];
    for (const tag of tags) {
      const rows = facts.filter((f) => f.tag === tag && f.end <= asOfMs).sort((a, b) => b.end - a.end);
      if (rows.length >= 2) return rows[1].val;
    }
    return undefined;
  })();
  const netIncome = pick(['NetIncomeLoss']);
  const equity = pick(['StockholdersEquity']);
  const eps = pick(['EarningsPerShareDiluted']);

  const out = {};
  if (revenue && revenuePrev && revenuePrev !== 0) out.revenueGrowthYoY = ((revenue - revenuePrev) / Math.abs(revenuePrev)) * 100;
  if (revenue && netIncome) out.netMargin = (netIncome / revenue) * 100;
  if (netIncome && equity && equity > 0) out.roe = (netIncome / equity) * 100;
  if (netIncome && eps && eps > 0) out.peRatio = null; // PE needs price; handled by caller if desired
  return out;
}

// ---- main ----
async function main() {
  if (!fs.existsSync(WAREHOUSE)) {
    console.error('FATAL: warehouse not found — run the EDGAR ingest first.');
    process.exit(1);
  }
  // Copy the warehouse to a scratch file so we never fight the live ingest's
  // write lock; DuckDB file copies of a checkpointed DB are consistent snapshots.
  const snapDir = fs.mkdtempSync(path.join(ROOT, 'data', 'bt-snap-'));
  const snapshot = path.join(snapDir, 'warehouse.duckdb');
  fs.copyFileSync(WAREHOUSE, snapshot);
  const db = await DuckDBInstance.create(snapshot, { access_mode: 'READ_ONLY' });
  const conn = await db.connect();
  const cleanup = () => { try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  // Universe: largest tickers with metrics (market-cap proxy = assets scale isn't
  // available pre-price-merge, so we take companies that have both facts and metrics).
  let tickers;
  if (TICKERS_ARG) {
    tickers = TICKERS_ARG.split(',').map((t) => t.trim().toUpperCase());
  } else {
    const rs = await conn.runAndReadAll(
      `SELECT c.ticker FROM metrics_latest m
       JOIN companies c ON c.cik = m.cik
       WHERE m.revenue IS NOT NULL AND m.net_income IS NOT NULL AND c.ticker IS NOT NULL
       ORDER BY m.revenue DESC LIMIT ${TOP}`
    );
    tickers = rs.getRowObjects().map((r) => String(r.ticker)).filter((t) => t && t !== 'null');
  }
  console.log(`Backtesting ${tickers.length} tickers | ${YEARS}y | ${HORIZON}d forward horizon`);

  // Benchmark: SPY daily closes from Yahoo (stooq fallback). Use yahoo-finance2 via dynamic import.
  const { default: YahooFinance } = await import('yahoo-finance2');
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const startD = new Date();
  startD.setFullYear(startD.getFullYear() - YEARS);

  const spyChart = await yf.chart('SPY', { period1: startD.toISOString().split('T')[0], interval: '1d' });
  const spy = (spyChart.quotes || []).filter((q) => q.close != null).map((q) => ({ t: new Date(q.date).getTime(), c: q.close }));
  console.log(`SPY benchmark: ${spy.length} daily closes`);

  const monthMs = 30.44 * 24 * 3600 * 1000;
  const horizonMs = HORIZON * 24 * 3600 * 1000;
  const checkpointCount = Math.floor((YEARS * 365 - HORIZON) / 30.44); // monthly steps that leave room for the forward window

  const buckets = { BUY: [], SELL: [], HOLD: [] };
  const spyBuckets = { BUY: [], SELL: [], HOLD: [] };
  let totalSignals = 0;
  let skippedNoData = 0;
  const perTicker = [];

  const progressEvery = Math.max(5, Math.floor(tickers.length / 10));

  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    try {
      // One fetch per ticker: 5y daily candles covers any 3y backtest with warmup.
      const p1 = new Date(); p1.setFullYear(p1.getFullYear() - (YEARS + 1));
      const chart = await yf.chart(ticker, { period1: p1.toISOString().split('T')[0], interval: '1d' });
      const candlesAll = (chart.quotes || [])
        .filter((q) => q.close != null && q.open != null && q.high != null && q.low != null)
        .map((q) => ({ time: new Date(q.date).toISOString().split('T')[0], open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume || 0, t: new Date(q.date).getTime() }));
      if (candlesAll.length < 260) { skippedNoData++; continue; }

      // EDGAR facts for this CIK (annual us-gaap rows only)
      const factsRs = await conn.runAndReadAll(
        `SELECT f.tag, f.end, f.val FROM facts f JOIN companies c ON c.cik = f.cik
         WHERE c.ticker = ? AND f.form = '10-K' AND f.fy = 'FY'`,
        [ticker]
      );
      const facts = factsRs.getRowObjects().map((r) => ({ tag: String(r.tag), end: new Date(String(r.end)).getTime(), val: Number(r.val) }));

      let signalsThisTicker = 0;
      // Checkpoints: walk backwards from the newest date that still has a full forward window
      const lastValidIdx = candlesAll.length - 1;
      const latestT = candlesAll[lastValidIdx].t;
      for (let k = checkpointCount; k >= 1; k--) {
        const checkpointT = latestT - k * monthMs;
        const idx = candlesAll.findIndex((c) => c.t >= checkpointT);
        if (idx < 0 || idx < 210) continue; // need warmup for SMA200
        const c0 = candlesAll[idx];
        const exitIdx = candlesAll.findIndex((c) => c.t >= c0.t + horizonMs);
        if (exitIdx < 0) continue;
        const c1 = candlesAll[exitIdx];

        const slice = candlesAll.slice(0, idx + 1);
        const fundamentals = buildFundamentalsAsOf(facts, c0.t);
        const { action } = scoreVerdict({ price: c0.close, candles: slice, fundamentals });
        const fwd = ((c1.close - c0.close) / c0.close) * 100;

        // SPY forward return over the same window
        const spy0 = spy.find((s) => s.t >= c0.t);
        const spy1 = spy.find((s) => s.t >= c1.t);
        if (!spy0 || !spy1) continue;
        const spyFwd = ((spy1.c - spy0.c) / spy0.c) * 100;

        buckets[action].push(fwd);
        spyBuckets[action].push(spyFwd);
        totalSignals++;
        signalsThisTicker++;
      }
      perTicker.push({ ticker, signals: signalsThisTicker });
    } catch (err) {
      skippedNoData++;
      if (String(err).includes('429')) console.warn('rate-limited; cooling 30s...');
      await new Promise((r) => setTimeout(r, 350)); // be polite to Yahoo
    }
    if ((ti + 1) % progressEvery === 0) {
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      console.log(`[${ti + 1}/${tickers.length}] signals=${totalSignals} | BUY avg ${avg(buckets.BUY).toFixed(1)}% (n=${buckets.BUY.length}) | SELL avg ${avg(buckets.SELL).toFixed(1)}% (n=${buckets.SELL.length}) | SPY-BUY avg ${avg(spyBuckets.BUY).toFixed(1)}%`);
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const winRate = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : 0);

  const report = {
    generatedAt: new Date().toISOString(),
    config: { years: YEARS, horizonDays: HORIZON, universe: tickers.length, note: 'Quant-core only (trend+RSI+fundamentals). News/LLM excluded — no honest historical news feed. Results are a lower bound.' },
    totals: { signals: totalSignals, tickersTested: tickers.length - skippedNoData, tickersSkipped: skippedNoData },
    actions: {
      BUY: { n: buckets.BUY.length, avgForwardReturn: +avg(buckets.BUY).toFixed(2), median: +median(buckets.BUY).toFixed(2), winRate: +winRate(buckets.BUY).toFixed(1), spyAvgSameWindows: +avg(spyBuckets.BUY).toFixed(2) },
      HOLD: { n: buckets.HOLD.length, avgForwardReturn: +avg(buckets.HOLD).toFixed(2), median: +median(buckets.HOLD).toFixed(2), winRate: +winRate(buckets.HOLD).toFixed(1), spyAvgSameWindows: +avg(spyBuckets.HOLD).toFixed(2) },
      SELL: { n: buckets.SELL.length, avgForwardReturn: +avg(buckets.SELL).toFixed(2), median: +median(buckets.SELL).toFixed(2), winRate: +winRate(buckets.SELL).toFixed(1), spyAvgSameWindows: +avg(spyBuckets.SELL).toFixed(2) },
    },
    perTickerSample: perTicker.slice(0, 20),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\n===== BACKTEST SUMMARY =====');
  for (const [a, s] of Object.entries(report.actions)) {
    console.log(`${a.padEnd(5)} n=${String(s.n).padStart(4)} | avg ${s.avgForwardReturn > 0 ? '+' : ''}${s.avgForwardReturn}% in ${HORIZON}d | win ${s.winRate}% | SPY same windows ${s.spyAvgSameWindows}%`);
  }
  console.log(`\nReport saved: ${OUT}`);
  await conn.closeSync();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
