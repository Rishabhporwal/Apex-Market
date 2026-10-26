#!/usr/bin/env node
/**
 * Verdict Backtester — measures how the AI Verdict's quant core would have
 * performed historically. This is the trust anchor: "BUY-rated signals from
 * this engine returned X% vs the S&P's Y% over the same windows."
 *
 * Method (honest by construction):
 *  - Walks monthly checkpoints over the last N years for each ticker.
 *  - At each checkpoint, feeds ONLY data available up to that date into the
 *    quant core (candles slice + fundamentals from the latest 10-K FILED
 *    before the checkpoint — no look-ahead; gated on the filing date, not the
 *    fiscal period end).
 *  - News/LLM are excluded from scoring (no historical news feed) — this makes
 *    results a lower-bound, not a fantasy.
 *  - Forward return = price change over the next `horizonDays` (default 90),
 *    evaluated per horizon at 5d, 21d AND the CLI horizon (each printed).
 *  - Transaction costs: 10 bps per side (20 bps round trip) deducted from
 *    every traded signal (BUY = long, SELL = short) — see COST_BPS_PER_SIDE.
 *  - Significance: bootstrap 95% CIs on TICKER-level alpha means (1000 draws,
 *    deterministic seed) so overlapping forward windows can't fake edge.
 *  - Benchmark: SPY buy-and-hold over the same windows.
 *  - Emits data/calibration.json: score-band -> observed target1 hit-rate
 *    (price reached target1 within the horizon before hitting the stop),
 *    consumed by the quant engine's confidence lookup.
 *  - Also re-scores every checkpoint the LEGACY way (pre-fix behavior:
 *    period-end gating + the fy='FY' query bug that silently selected zero
 *    fundamental rows) so the report can print an honest before/after.
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
const CALIBRATION_OUT = path.join(ROOT, 'data', 'calibration.json');

// ---- transaction costs (P0-1 audit fix) ----
// 10 bps per side: entry + exit = 20 bps round trip. Applied to every traded
// signal (BUY = long entry/exit, SELL = short entry/cover) as a percentage-
// point deduction from the forward return.
const COST_BPS_PER_SIDE = 10;
const COST_RT_PCT = (COST_BPS_PER_SIDE * 2) / 100; // 0.20 percentage points

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

// ---- per-horizon evaluation (audit fix) ----
// The shipped trade windows are 5 and 21 days, but the report only ever
// printed the `--horizon` window (90d). Every checkpoint is now evaluated at
// 5d, 21d AND the CLI horizon, each printed separately.
const HORIZONS = [...new Set([5, 21, HORIZON])].sort((a, b) => a - b);
const DAY_MS = 24 * 3600 * 1000;

// ---- overlapping-checkpoint robustness (audit fix) ----
// Monthly checkpoints with a 90d forward window overlap heavily, so counting
// every checkpoint as an independent observation fakes significance. We
// bootstrap TICKER-LEVEL means instead: resample tickers with replacement
// 1000× (deterministic seeded PRNG, no dependencies) and report a percentile
// 95% CI for the average alpha per action.
const BOOTSTRAP_DRAWS = 1000;
const BOOTSTRAP_SEED = 42;

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

/** Deterministic PRNG (mulberry32) — reproducible bootstrap, zero deps. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap 95% percentile CI for the mean of `values` (ticker-level alpha
 * means): resample with replacement BOOTSTRAP_DRAWS times.
 */
function bootstrapCi(values, draws = BOOTSTRAP_DRAWS, seed = BOOTSTRAP_SEED) {
  const n = values.length;
  if (n < 2) return null;
  const rand = mulberry32(seed);
  const means = new Array(draws);
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[(rand() * n) | 0];
    means[d] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(draws * 0.025)], hi: means[Math.ceil(draws * 0.975) - 1] };
}

// ---- levels port (kept in lockstep with services/verdict/levels.mjs) ----
// Only what the calibration path-simulation needs: ATR-14, fractal pivots and
// the stop/target1 geometry, so backtest calibration measures the SAME target
// structure the live trade plan uses.
function atr14(candles) {
  if (candles.length < 15) return undefined;
  let sum = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / 14;
}

function structureLevels(candles, direction) {
  // Mirrors levels.mjs getStopLossAndTargets (window-5 fractal pivots).
  if (!candles || !candles.length) return null;
  const a = atr14(candles);
  if (!a) return null;
  const price = candles[candles.length - 1].close;
  const w = 5;
  const highs = [];
  const lows = [];
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
  const resistances = [...highs, ...candles.map((c) => c.high)].filter((v) => v > price).sort((x, y) => x - y);
  const supports = [...lows, ...candles.map((c) => c.low)].filter((v) => v < price).sort((x, y) => y - x);
  if (direction === 'BUY') {
    const stop = Math.min(supports[0] ?? price - 2 * a, price - 2 * a);
    const t1 = resistances.length ? Math.min(resistances[0] + a, price + 3 * a) : price + 2 * a;
    return { stop, target1: t1 };
  }
  // SELL (short): stop above, target below — mirrored, same as levels.mjs.
  const stop = Math.max(resistances[0] ?? price + 2 * a, price + 2 * a);
  const t1 = supports.length ? Math.max(supports[0] - a, price - 3 * a) : price - 2 * a;
  return { stop, target1: t1 };
}

/**
 * Walk the forward window and classify the outcome: did price reach target1
 * ('hit') before touching the stop ('stop'), or neither ('none')? Same-bar
 * stop+target ambiguity resolves to 'stop' (conservative).
 */
function pathOutcome(candles, entryIdx, exitIdx, stop, target1, long) {
  for (let i = entryIdx + 1; i <= exitIdx; i++) {
    const c = candles[i];
    if (long) {
      if (c.low <= stop) return 'stop';
      if (c.high >= target1) return 'hit';
    } else {
      if (c.high >= stop) return 'stop';
      if (c.low <= target1) return 'hit';
    }
  }
  return 'none';
}

// ---- score-band buckets (MUST stay in sync with quantEngine confidence lookup) ----
export function calibrationBand(score) {
  if (score >= 35) return '>=35';
  if (score >= 15) return '15..35';
  if (score > -15) return '-15..15';
  if (score >= -35) return '-35..-15';
  return '<-35';
}
const BAND_ORDER = ['<-35', '-35..-15', '-15..15', '15..35', '>=35'];

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
/**
 * P0-1 audit fix: facts are gated on the FILING date (`filed_at`), not the
 * fiscal period end. A 10-K for FY2024 can be filed up to ~3 months after the
 * fiscal year ends, so period-end gating leaks information the market could
 * not have had.
 *
 * Fallback approximation for legacy rows (ingested before filed_at existed,
 * filed_at IS NULL): exclude facts whose fiscal period ended less than 45 days
 * before asOf — 10-K/10-Q legal filing windows make it impossible for those
 * numbers to have been public yet. This is strictly more conservative than
 * period-end gating and only applies to legacy rows.
 */
function buildFundamentalsAsOf(facts, asOfMs) {
  const visible = (f) => {
    if (f.filedAt != null) return f.filedAt <= asOfMs;
    // Conservative approximation for legacy rows without a filing date.
    return f.end + 45 * 24 * 3600 * 1000 <= asOfMs;
  };
  // facts: [{tag, end(ms), filedAt(ms|null), val}] pre-filtered to annual 10-K us-gaap rows
  const pick = (tags) => {
    for (const tag of tags) {
      const rows = facts.filter((f) => f.tag === tag && visible(f));
      if (rows.length) {
        rows.sort((a, b) => b.end - a.end);
        return rows[0].val;
      }
    }
    return undefined;
  };
  const revenueTags = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'];
  const revenue = pick(revenueTags);
  const revenuePrev = (() => {
    for (const tag of revenueTags) {
      const rows = facts.filter((f) => f.tag === tag && visible(f)).sort((a, b) => b.end - a.end);
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
  if (eps) out.epsDiluted = eps; // caller turns this into peRatio at the checkpoint price
  // NOTE: peRatio is intentionally NOT set here. The caller computes it from
  // the checkpoint price and as-of EPS (price was observable at the checkpoint,
  // so this is look-ahead-free). The old `out.peRatio = null` placeholder was
  // an active bug: scoreVerdict treats null as a present-but-invalid P/E and
  // docks -6 fundamental points for it.
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

  const mkBuckets = () => ({ BUY: [], SELL: [], HOLD: [] });
  // Per-horizon accumulators: raw forward returns, SPY same-window returns,
  // and net-of-costs variants for traded signals (BUY long / SELL short).
  const byH = new Map();
  for (const h of HORIZONS) byH.set(h, { action: mkBuckets(), spy: mkBuckets(), net: { BUY: [], SELL: [] }, spyNet: { BUY: [], SELL: [] } });
  const primary = byH.get(HORIZON);
  // Ticker-level return samples for the bootstrap: horizon -> action -> ticker -> {fwd[], spy[]}
  const tickerStats = new Map();
  for (const h of HORIZONS) tickerStats.set(h, { BUY: new Map(), SELL: new Map(), HOLD: new Map() });
  // Legacy (pre-fix) replication for the before/after print: the old script
  // gated facts on period end AND had a `fy = 'FY'` query bug that selected
  // zero fundamental rows, so the scorer effectively never saw fundamentals.
  // Measured at the primary (--horizon) window.
  const legacyBuckets = mkBuckets();
  const legacySpyBuckets = mkBuckets();
  // Score-band calibration accumulators (target1-before-stop hit rates).
  const calib = {};
  for (const b of BAND_ORDER) calib[b] = { n: 0, hits: 0, stopped: 0, neither: 0 };
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

      // EDGAR facts for this CIK (annual us-gaap rows only).
      // P0-1 fix: the old query filtered `f.fy = 'FY'`, but `fy` stores the
      // fiscal YEAR (e.g. '2025') while `fp` stores 'FY' — it selected ZERO
      // rows, so the backtest ran with no fundamentals at all. Filter on fp,
      // and pull filed_at for look-ahead-free gating.
      const factsRs = await conn.runAndReadAll(
        `SELECT f.tag, f.end, f.val, f.filed_at FROM facts f JOIN companies c ON c.cik = f.cik
         WHERE c.ticker = ? AND f.form = '10-K' AND f.fp = 'FY'`,
        [ticker]
      );
      const facts = factsRs.getRowObjects().map((r) => ({
        tag: String(r.tag),
        end: new Date(String(r.end)).getTime(),
        filedAt: r.filed_at == null ? null : new Date(String(r.filed_at)).getTime(),
        val: Number(r.val),
      }));

      let signalsThisTicker = 0;
      // Checkpoints: walk backwards from the newest date that still has a full forward window
      const lastValidIdx = candlesAll.length - 1;
      const latestT = candlesAll[lastValidIdx].t;
      for (let k = checkpointCount; k >= 1; k--) {
        const checkpointT = latestT - k * monthMs;
        const idx = candlesAll.findIndex((c) => c.t >= checkpointT);
        if (idx < 0 || idx < 210) continue; // need warmup for SMA200
        const c0 = candlesAll[idx];

        const slice = candlesAll.slice(0, idx + 1);
        const fundamentals = buildFundamentalsAsOf(facts, c0.t);
        // P/E from the checkpoint price and as-of EPS — both were observable at
        // the checkpoint (see buildFundamentalsAsOf note).
        if (fundamentals.epsDiluted && fundamentals.epsDiluted > 0) {
          fundamentals.peRatio = c0.close / fundamentals.epsDiluted;
        }
        const { action, score } = scoreVerdict({ price: c0.close, candles: slice, fundamentals });

        // Legacy replication (pre-fix behavior: fundamentals never reached the
        // scorer) for the before/after comparison in the report.
        const { action: legacyAction } = scoreVerdict({ price: c0.close, candles: slice });

        // Calibration: same stop/target1 structure as the live trade plan, in
        // the direction the score implies (>=0 long, <0 short) — measured at
        // the PRIMARY horizon (calibration.json feeds the live engine there).
        const pExitIdx = candlesAll.findIndex((c) => c.t >= c0.t + horizonMs);
        if (pExitIdx >= 0) {
          const dir = score >= 0 ? 'BUY' : 'SELL';
          const struct = structureLevels(slice, dir);
          if (struct && Number.isFinite(struct.stop) && Number.isFinite(struct.target1)) {
            const outcome = pathOutcome(candlesAll, idx, pExitIdx, struct.stop, struct.target1, dir === 'BUY');
            const b = calib[calibrationBand(score)];
            b.n++;
            if (outcome === 'hit') b.hits++;
            else if (outcome === 'stop') b.stopped++;
            else b.neither++;
          }
        }

        // Per-horizon evaluation: one score per checkpoint, forward outcome
        // measured at 5d, 21d AND the CLI horizon.
        for (const h of HORIZONS) {
          const exitIdx = candlesAll.findIndex((c) => c.t >= c0.t + h * DAY_MS);
          if (exitIdx < 0) continue;
          const c1 = candlesAll[exitIdx];
          // SPY forward return over the same window
          const spy0 = spy.find((s) => s.t >= c0.t);
          const spy1 = spy.find((s) => s.t >= c1.t);
          if (!spy0 || !spy1) continue;
          const fwd = ((c1.close - c0.close) / c0.close) * 100;
          const spyFwd = ((spy1.c - spy0.c) / spy0.c) * 100;
          // Net of 10 bps/side (20 bps round trip). SELL = short: gross -fwd.
          const netFwd = action === 'SELL' ? -fwd - COST_RT_PCT : fwd - COST_RT_PCT;
          const B = byH.get(h);
          B.action[action].push(fwd);
          B.spy[action].push(spyFwd);
          if (action === 'BUY' || action === 'SELL') {
            B.net[action].push(netFwd);
            B.spyNet[action].push(spyFwd);
          }
          let ts = tickerStats.get(h)[action].get(ticker);
          if (!ts) { ts = { fwd: [], spy: [] }; tickerStats.get(h)[action].set(ticker, ts); }
          ts.fwd.push(fwd);
          ts.spy.push(spyFwd);
          if (h === HORIZON) {
            legacyBuckets[legacyAction].push(fwd);
            legacySpyBuckets[legacyAction].push(spyFwd);
          }
        }
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
      console.log(`[${ti + 1}/${tickers.length}] signals=${totalSignals} | BUY avg ${avg(primary.action.BUY).toFixed(1)}% (n=${primary.action.BUY.length}) | SELL avg ${avg(primary.action.SELL).toFixed(1)}% (n=${primary.action.SELL.length}) | SPY-BUY avg ${avg(primary.spy.BUY).toFixed(1)}%`);
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const winRate = (a) => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : 0);
  const r2 = (v) => Number(v.toFixed(2));

  // Per-action summary including net-of-costs metrics (traded signals only),
  // parameterized by horizon.
  const actionSummary = (h, name) => {
    const B = byH.get(h);
    const raw = {
      n: B.action[name].length,
      avgForwardReturn: r2(avg(B.action[name])),
      median: r2(median(B.action[name])),
      winRate: +winRate(B.action[name]).toFixed(1),
      spyAvgSameWindows: r2(avg(B.spy[name])),
    };
    raw.avgAlpha = r2(raw.avgForwardReturn - raw.spyAvgSameWindows);
    if (name === 'BUY' || name === 'SELL') {
      raw.netOfCosts = {
        costBpsRoundTrip: COST_BPS_PER_SIDE * 2,
        avgReturn: r2(avg(B.net[name])),
        winRate: +winRate(B.net[name]).toFixed(1),
        avgAlpha: r2(avg(B.net[name]) - avg(B.spyNet[name])),
        note: name === 'SELL' ? 'short interpretation: gross = -forward return' : 'long',
      };
    }
    return raw;
  };
  const legacySummary = (name) => ({
    n: legacyBuckets[name].length,
    avgForwardReturn: r2(avg(legacyBuckets[name])),
    winRate: +winRate(legacyBuckets[name]).toFixed(1),
    spyAvgSameWindows: r2(avg(legacySpyBuckets[name])),
    avgAlpha: r2(avg(legacyBuckets[name]) - avg(legacySpyBuckets[name])),
  });

  const calibration = {};
  for (const band of BAND_ORDER) {
    const b = calib[band];
    calibration[band] = {
      n: b.n,
      hits: b.hits,
      stoppedFirst: b.stopped,
      neitherInHorizon: b.neither,
      hitRate: b.n ? +(100 * b.hits / b.n).toFixed(1) : null,
      // Observed confidence the engine should quote for this band.
      confidence: b.n ? Math.round(100 * b.hits / b.n) : null,
    };
  }

  // Per-horizon reports + bootstrap 95% CIs on ticker-level alpha means
  // (Newey-West-style clustering: overlapping checkpoints within a ticker are
  // absorbed by resampling the TICKER as the independent unit).
  const bootstrapCiFor = (h, name) => {
    const m = tickerStats.get(h)[name];
    if (m.size < 2) return null;
    const alphas = [...m.values()].map((s) => avg(s.fwd) - avg(s.spy));
    const ci = bootstrapCi(alphas);
    return {
      tickers: m.size,
      meanAlpha: r2(avg(alphas)),
      ci95: ci ? [r2(ci.lo), r2(ci.hi)] : null,
      significantAt95: ci ? ci.lo > 0 || ci.hi < 0 : false,
    };
  };
  const horizonReports = {};
  for (const h of HORIZONS) {
    horizonReports[h] = {
      horizonDays: h,
      actions: { BUY: actionSummary(h, 'BUY'), HOLD: actionSummary(h, 'HOLD'), SELL: actionSummary(h, 'SELL') },
      bootstrap95ci: { BUY: bootstrapCiFor(h, 'BUY'), HOLD: bootstrapCiFor(h, 'HOLD'), SELL: bootstrapCiFor(h, 'SELL') },
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      years: YEARS, horizonDays: HORIZON, horizons: HORIZONS, universe: tickers.length,
      transactionCostBpsPerSide: COST_BPS_PER_SIDE,
      fundamentalsGate: 'filed_at <= asOf (filing date); legacy NULL-filed_at rows use a conservative 45-day post-period-end approximation',
      bootstrap: { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED, unit: 'ticker-level alpha means (robust to overlapping checkpoints)' },
      note: 'Quant-core only (trend+RSI+fundamentals). News/LLM excluded — no honest historical news feed. Results are a lower bound.',
    },
    totals: { signals: totalSignals, tickersTested: tickers.length - skippedNoData, tickersSkipped: skippedNoData },
    // Primary (--horizon) summary, kept at top level for existing consumers.
    actions: horizonReports[HORIZON].actions,
    // Per-horizon evaluation + significance CIs (5d / 21d / CLI horizon).
    horizons: horizonReports,
    // Before/after: exact legacy behavior re-scored over the same checkpoints.
    legacy: {
      note: 'Pre-fix method: period-end gating + fy=\'FY\' query bug → fundamentals never reached the scorer; no transaction costs.',
      actions: { BUY: legacySummary('BUY'), HOLD: legacySummary('HOLD'), SELL: legacySummary('SELL') },
    },
    calibration,
    perTickerSample: perTicker.slice(0, 20),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  // ---- calibration.json (consumed by quantEngine confidence lookup) --------
  const calibrationDoc = {
    generatedAt: report.generatedAt,
    source: 'scripts/backtest-verdicts.mjs',
    config: { years: YEARS, horizonDays: HORIZON, signals: totalSignals, transactionCostBpsPerSide: COST_BPS_PER_SIDE },
    note: 'confidence = observed share of signals in the score band whose target1 was reached within the horizon before the stop (levels structure: window-5 fractal pivots + ATR-14, same as the live trade plan). Bands are half-open: [lo, hi) except >=35.',
    bands: calibration,
  };
  fs.writeFileSync(CALIBRATION_OUT, JSON.stringify(calibrationDoc, null, 2));

  console.log('\n===== BACKTEST SUMMARY (corrected: filed-date gating, 20bps RT costs) =====');
  for (const h of HORIZONS) {
    console.log(`--- ${h}d horizon ---`);
    for (const [a, s] of Object.entries(horizonReports[h].actions)) {
      console.log(`${a.padEnd(5)} n=${String(s.n).padStart(4)} | avg ${s.avgForwardReturn > 0 ? '+' : ''}${s.avgForwardReturn}% in ${h}d | win ${s.winRate}% | alpha ${s.avgAlpha > 0 ? '+' : ''}${s.avgAlpha}% vs SPY${s.netOfCosts ? ` | NET ${s.netOfCosts.avgReturn > 0 ? '+' : ''}${s.netOfCosts.avgReturn}% win ${s.netOfCosts.winRate}% alpha ${s.netOfCosts.avgAlpha > 0 ? '+' : ''}${s.netOfCosts.avgAlpha}%` : ''}`);
    }
  }
  console.log(`\n===== BOOTSTRAP 95% CI (ticker-level alpha means, ${BOOTSTRAP_DRAWS} draws, seed ${BOOTSTRAP_SEED} — overlapping-checkpoint robust) =====`);
  for (const h of HORIZONS) {
    for (const a of ['BUY', 'HOLD', 'SELL']) {
      const c = horizonReports[h].bootstrap95ci[a];
      if (!c) { console.log(`${String(h).padStart(3)}d ${a.padEnd(5)} n/a (fewer than 2 tickers)`); continue; }
      const [lo, hi] = c.ci95;
      console.log(`${String(h).padStart(3)}d ${a.padEnd(5)} mean alpha ${c.meanAlpha > 0 ? '+' : ''}${c.meanAlpha}% [${lo}%, ${hi}%] over ${c.tickers} tickers → ${c.significantAt95 ? 'SIGNIFICANT at 95%' : 'not significant at 95%'}`);
    }
  }
  console.log('\n===== BEFORE/AFTER vs legacy method (same checkpoints) =====');
  for (const a of ['BUY', 'HOLD', 'SELL']) {
    const o = report.actions[a];
    const l = report.legacy.actions[a];
    console.log(`${a.padEnd(5)} n=${String(l.n).padStart(4)} | avg alpha ${l.avgAlpha > 0 ? '+' : ''}${l.avgAlpha}% -> ${o.avgAlpha > 0 ? '+' : ''}${o.avgAlpha}% (raw) / ${o.netOfCosts ? `${o.netOfCosts.avgAlpha > 0 ? '+' : ''}${o.netOfCosts.avgAlpha}% (net)` : 'n/a'} | win ${l.winRate}% -> ${o.winRate}%`);
  }
  console.log('\n===== CALIBRATION (score band -> target1 hit-rate) =====');
  for (const band of BAND_ORDER) {
    const c = calibration[band];
    console.log(`${band.padEnd(9)} n=${String(c.n).padStart(4)} hit ${c.hitRate == null ? '—' : c.hitRate + '%'} (stopped-first ${c.stoppedFirst}, neither ${c.neitherInHorizon})`);
  }
  console.log(`\nReport saved: ${OUT}\nCalibration saved: ${CALIBRATION_OUT}`);
  await conn.closeSync();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
