#!/usr/bin/env node
/**
 * Short-horizon reversal lab — diagnoses and tests fixes for the finding that
 * BUY-signaled names UNDERPERFORM at 5d/21d horizons (momentum reversal) while
 * 90d ranking is monotone-positive (engine v3: trend 0 / rsi 5 / fund 0 /
 * mom 20 / sent 25).
 *
 * Reuses scripts/weight-search.mjs's exact pattern: same universe query, same
 * look-ahead-free fundamentals gating, same cross-sectional sector percentiles,
 * same quintile/Spearman machinery, same ticker-level bootstrap (1000 draws,
 * seed 42) — but evaluates every checkpoint at 5d, 21d AND 90d and treats the
 * short-term prior returns as PARAMETERS:
 *
 *   Task 1 — profile WHERE the reversal lives: per engine-score quintile and
 *           per month, 5d/21d alpha; BUY signals split by prior-5d return.
 *   Task 2 — grid-test reversal fixes against the v3 baseline:
 *             a) momentum damping: momEff = clamp(m121*50 − λ·clamp(rD*50, ±10), ±10)
 *                for D ∈ {5, 21}, λ ∈ {0.5, 1, 2}
 *             b) overextension gate: BUY → HOLD when prior rD > threshold
 *                (r5 > +8%, r5 > +12%, r21 > +15%)
 *
 * Anti-overfitting (same guardrails as weight-search): first-half vs
 * second-half per-month Spearman reported SEPARATELY; adoption requires sign
 * agreement in BOTH halves, 21d BUY alpha improvement in both halves, and no
 * destruction of the 90d Spearman.
 *
 * Data: warehouse copied to a scratch snapshot (DuckDB single-writer); Yahoo
 * candles cached to tmp/bt-data-cache-<top>.json so reruns don't re-fetch.
 * Nothing here writes to the live warehouse or the shipped report.
 *
 * Usage:  node scripts/reversal-lab.mjs [--years=3] [--top=600] [--refresh]
 * Output: data/reversal-lab.json + tmp/reversal-lab-summary.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(process.cwd());
const WAREHOUSE = path.join(ROOT, 'data', 'warehouse.duckdb');
const OUT = path.join(ROOT, 'data', 'reversal-lab.json');
const SUMMARY = path.join(ROOT, 'tmp', 'reversal-lab-summary.md');
const CACHE_PATTERN = (top) => path.join(ROOT, 'tmp', `bt-data-cache-${top}.json`);

// ---- args ----
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const YEARS = Number(getArg('years', 3));
const TOP = Number(getArg('top', 600));
const REFRESH = args.includes('--refresh');
const DAY_MS = 24 * 3600 * 1000;
const HORIZONS = [5, 21, 90]; // evaluated per checkpoint, per variant

// ---- v3 adopted weights (mirrors quantEngine.mjs/.ts — keep in lockstep) ----
const FACTOR_WEIGHTS = { trend: 0, rsi: 5, fund: 0, mom: 20, sent: 25 };
const FACTOR_CAPS = { trend: 25, rsi: 15, fund: 35, mom: 10, sent: 25 };
const TOTAL_SCALE = 110;
const MOM_BLOCK_MAX = 10;
const DAMP_POINT_SCALE = 50; // prior-return → momentum-points scale (20% ⇒ ±10, same as 12-1 momentum)

// ---- variant grid ----
// damp: momentum damping (window in trading days, lambda multiplier).
// gate: overextension filter (prior return in % that demotes BUY → HOLD).
const VARIANTS = [
  { id: 'baseline', label: 'v3 baseline (no fix)', damp: null, gate: null },
  { id: 'damp21-l0.5', label: 'damp momentum with 0.5× prior-21d', damp: { window: 21, lambda: 0.5 }, gate: null },
  { id: 'damp21-l1', label: 'damp momentum with 1× prior-21d', damp: { window: 21, lambda: 1 }, gate: null },
  { id: 'damp21-l2', label: 'damp momentum with 2× prior-21d', damp: { window: 21, lambda: 2 }, gate: null },
  { id: 'damp5-l1', label: 'damp momentum with 1× prior-5d', damp: { window: 5, lambda: 1 }, gate: null },
  { id: 'damp5-l2', label: 'damp momentum with 2× prior-5d', damp: { window: 5, lambda: 2 }, gate: null },
  { id: 'gate5-8', label: 'gate BUY when 5d move > +8%', damp: null, gate: { window: 5, threshold: 8 } },
  { id: 'gate5-12', label: 'gate BUY when 5d move > +12%', damp: null, gate: { window: 5, threshold: 12 } },
  { id: 'gate21-15', label: 'gate BUY when 21d move > +15%', damp: null, gate: { window: 21, threshold: 15 } },
];

// ---- quant-core mirrors (verbatim from scripts/weight-search.mjs) ----
const sma = (v, p) => (v.length < p ? undefined : v.slice(-p).reduce((a, b) => a + b, 0) / p);

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return undefined;
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
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function classifyTrend(price, s50, s200) {
  if (s50 && s200) {
    if (price > s50 && s50 > s200) return 'up';
    if (price < s50 && s50 < s200) return 'down';
  }
  return 'sideways';
}

function percentileRank(sortedValues, x) {
  if (!Array.isArray(sortedValues) || sortedValues.length < 5) return undefined;
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  let below = 0;
  let equal = 0;
  for (const v of sortedValues) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return Math.round(((below + 0.5 * equal) / sortedValues.length) * 100);
}

const FUNDAMENTAL_FACTORS = [
  { key: 'growth', weight: 12, direction: 1, raw: 'revenueGrowthYoY' },
  { key: 'margin', weight: 9, direction: 1, raw: 'netMargin' },
  { key: 'roe', weight: 8, direction: 1, raw: 'roe' },
  { key: 'pe', weight: 6, direction: -1, raw: 'peRatio' },
];

function renormalize(weightedSum, weightSum, lo = 0, hi = 100) {
  if (!(weightSum > 0)) return undefined;
  const avg = weightedSum / weightSum;
  return hi > lo ? ((avg - lo) / (hi - lo)) * 100 : 50;
}

function fundamentalsComposite(pct, fundamentals) {
  let weightedSum = 0;
  let weightSum = 0;
  for (const f of FUNDAMENTAL_FACTORS) {
    const raw = fundamentals ? fundamentals[f.raw] : undefined;
    const pctile = pct ? pct[f.key] : undefined;
    if (raw === undefined || !Number.isFinite(raw) || pctile === undefined) continue;
    weightedSum += f.weight * (f.direction > 0 ? pctile : 100 - pctile);
    weightSum += f.weight;
  }
  if (!(weightSum > 0)) return undefined;
  const composite = renormalize(weightedSum, weightSum) ?? 50;
  return Math.max(-35, Math.min(35, ((composite - 50) / 50) * 35));
}

function momentum121(closes) {
  if (!Array.isArray(closes) || closes.length < 253) return undefined;
  const past = closes[closes.length - 253];
  const prev = closes[closes.length - 22];
  if (!(past > 0) || !(prev > 0)) return undefined;
  return prev / past - 1;
}

/** Raw block points at the SHIPPED caps — variants rescale/modify these. */
function rawBlockPoints({ price, closes, fundamentals, sectorPercentiles }) {
  const pct = sectorPercentiles || {};
  const trend = classifyTrend(price, sma(closes, 50), sma(closes, 200));
  const rv = rsi(closes, 14);
  let trendPts = 0;
  if (trend === 'up') trendPts = 25;
  else if (trend === 'down') trendPts = -25;
  let rsiPts = 0;
  if (rv !== undefined) {
    if (rv < 30) rsiPts = 15;
    else if (rv < 45) rsiPts = 7;
    else if (rv > 70) rsiPts = -15;
    else if (rv > 55) rsiPts = -7;
  }
  let fundPts = 0;
  if (fundamentals) {
    const comp = fundamentalsComposite(pct, fundamentals);
    if (comp !== undefined) {
      fundPts = comp;
    } else {
      let f = 0;
      if (fundamentals.revenueGrowthYoY !== undefined) f += fundamentals.revenueGrowthYoY > 10 ? 12 : fundamentals.revenueGrowthYoY > 0 ? 6 : fundamentals.revenueGrowthYoY > -10 ? -6 : -12;
      if (fundamentals.netMargin !== undefined) f += fundamentals.netMargin > 20 ? 9 : fundamentals.netMargin > 5 ? 5 : fundamentals.netMargin > 0 ? 0 : -9;
      if (fundamentals.roe !== undefined) f += fundamentals.roe > 20 ? 8 : fundamentals.roe > 10 ? 4 : fundamentals.roe > 0 ? 0 : -8;
      if (fundamentals.peRatio !== undefined) f += fundamentals.peRatio > 0 && fundamentals.peRatio < 25 ? 6 : fundamentals.peRatio >= 25 && fundamentals.peRatio <= 60 ? 0 : -6;
      fundPts = Math.max(-35, Math.min(35, f));
    }
  }
  const m121 = momentum121(closes);
  const momRaw = m121 !== undefined ? m121 * 50 : null; // unclamped ±curve points
  // Short-term prior returns (trading-day windows, look-ahead-free):
  //   r5  = close[t] / close[t−5] − 1   (the skipped-week return)
  //   r21 = close[t] / close[t−21] − 1  (the skipped-month return — same
  //        anchor close the 12-1 momentum uses, so damping is well-posed)
  const n = closes.length;
  const r5 = n >= 6 && closes[n - 6] > 0 ? closes[n - 1] / closes[n - 6] - 1 : undefined;
  const r21 = n >= 22 && closes[n - 22] > 0 ? closes[n - 1] / closes[n - 22] - 1 : undefined;
  // SELL bearish votes (weight-independent, from raw indicators)
  let bearishVotes = 0;
  if (trend === 'down') bearishVotes++;
  if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) bearishVotes++;
  if (rv !== undefined && rv > 70) bearishVotes++;
  return { trendPts, rsiPts, fundPts, momRaw, r5, r21, trend, rv, bearishVotes };
}

// ---- look-ahead-free fundamentals as-of (verbatim from weight-search.mjs) ----
function buildFundamentalsAsOf(facts, asOfMs) {
  const visible = (f) => {
    if (f.filedAt != null) return f.filedAt <= asOfMs;
    return f.end + 45 * 24 * 3600 * 1000 <= asOfMs;
  };
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
  if (eps) out.epsDiluted = eps;
  return out;
}

function crossPercentiles(snapshot, valueOf) {
  const bySector = new Map();
  const all = [];
  for (const s of snapshot) {
    const v = valueOf(s);
    if (v === undefined || !Number.isFinite(v)) continue;
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector).push(v);
    all.push(v);
  }
  for (const arr of bySector.values()) arr.sort((a, b) => a - b);
  all.sort((a, b) => a - b);
  const pct = new Map();
  for (const s of snapshot) {
    const v = valueOf(s);
    if (v === undefined || !Number.isFinite(v)) continue;
    const sectorVals = bySector.get(s.sector) || [];
    if (sectorVals.length >= 5) pct.set(s.ticker, percentileRank(sectorVals, v));
    else if (all.length >= 10) pct.set(s.ticker, percentileRank(all, v));
  }
  return pct;
}

// ---- rank statistics (verbatim) ----
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function rankAvg(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function spearman(xs, ys) {
  return pearson(rankAvg(xs), rankAvg(ys));
}

const RANK_BUCKETS = 5;
const RANK_MIN_UNIVERSE = 10;

function quintileOf(position, n) {
  const base = Math.floor(n / RANK_BUCKETS);
  const rem = n % RANK_BUCKETS;
  let acc = 0;
  for (let q = 1; q <= RANK_BUCKETS; q++) {
    const size = base + (q <= rem ? 1 : 0);
    if (position < acc + size) return q;
    acc += size;
  }
  return RANK_BUCKETS;
}

// ---- bootstrap (verbatim) ----
const BOOTSTRAP_DRAWS = 1000;
const BOOTSTRAP_SEED = 42;
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
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

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r3 = (v) => (v == null ? null : Number(v.toFixed(3)));
const r2 = (v) => (v == null ? null : Number(v.toFixed(2)));

// ============================ data loading ============================
async function loadData() {
  const CACHE = CACHE_PATTERN(TOP);
  if (!REFRESH && fs.existsSync(CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (cached.years === YEARS && cached.top === TOP) {
        console.log(`Data cache hit: ${CACHE} (fetched ${cached.fetchedAt})`);
        return cached;
      }
      console.log('Data cache stale (config changed) — refetching.');
    } catch {
      console.log('Data cache unreadable — refetching.');
    }
  }

  if (!fs.existsSync(WAREHOUSE)) {
    console.error('FATAL: warehouse not found — run the EDGAR ingest first.');
    process.exit(1);
  }
  // DuckDB single-writer: copy the warehouse to a scratch snapshot first.
  const snapDir = fs.mkdtempSync(path.join(ROOT, 'data', 'bt-snap-'));
  const snapshot = path.join(snapDir, 'warehouse.duckdb');
  fs.copyFileSync(WAREHOUSE, snapshot);
  const db = await DuckDBInstance.create(snapshot, { access_mode: 'READ_ONLY' });
  const conn = await db.connect();
  const cleanup = () => { try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);

  const rs = await conn.runAndReadAll(
    `SELECT c.ticker FROM metrics_latest m
     JOIN companies c ON c.cik = m.cik
     WHERE m.revenue IS NOT NULL AND m.net_income IS NOT NULL AND c.ticker IS NOT NULL
     ORDER BY m.revenue DESC LIMIT ${TOP}`
  );
  const tickers = rs.getRowObjects().map((r) => String(r.ticker)).filter((t) => t && t !== 'null');

  const sectorMap = new Map();
  const sectorRs = await conn.runAndReadAll(`SELECT ticker, sector_label FROM companies WHERE ticker IS NOT NULL`);
  for (const r of sectorRs.getRowObjects()) sectorMap.set(String(r.ticker), r.sector_label == null ? null : String(r.sector_label));

  const { default: YahooFinance } = await import('yahoo-finance2');
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const startD = new Date();
  startD.setFullYear(startD.getFullYear() - YEARS);
  const spyChart = await yf.chart('SPY', { period1: startD.toISOString().split('T')[0], interval: '1d' });
  const spy = (spyChart.quotes || []).filter((q) => q.close != null).map((q) => ({ t: new Date(q.date).getTime(), c: q.close }));
  console.log(`SPY benchmark: ${spy.length} daily closes`);

  const universe = {};
  let skippedNoData = 0;
  const progressEvery = Math.max(5, Math.floor(tickers.length / 20));
  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti];
    try {
      const p1 = new Date(); p1.setFullYear(p1.getFullYear() - (YEARS + 1));
      const chart = await yf.chart(ticker, { period1: p1.toISOString().split('T')[0], interval: '1d' });
      const candlesAll = (chart.quotes || [])
        .filter((q) => q.close != null && q.open != null && q.high != null && q.low != null)
        .map((q) => ({ time: new Date(q.date).toISOString().split('T')[0], open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume || 0, t: new Date(q.date).getTime() }));
      if (candlesAll.length < 260) { skippedNoData++; continue; }
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
      universe[ticker] = { candles: candlesAll, facts, sector: sectorMap.get(ticker) ?? null };
    } catch (err) {
      skippedNoData++;
      if (String(err).includes('429')) console.warn('rate-limited; cooling 30s...');
      await new Promise((r) => setTimeout(r, 350));
    }
    if ((ti + 1) % progressEvery === 0) console.log(`[fetch ${ti + 1}/${tickers.length}] ok=${Object.keys(universe).length} skipped=${skippedNoData}`);
  }
  await conn.closeSync();
  cleanup();
  const doc = { fetchedAt: new Date().toISOString(), years: YEARS, top: TOP, spy, universe };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(doc));
  console.log(`Data cached: ${CACHE} (${Object.keys(universe).length} tickers)`);
  return doc;
}

// ======================= checkpoint factor table =======================
/** Build the per-(month,ticker) observation table ONCE with every horizon's
 *  forward outcome; variants only re-score these raw points. */
function buildCheckpoints(data) {
  const { spy, universe } = data;
  const tickerData = new Map();
  for (const [ticker, d] of Object.entries(universe)) tickerData.set(ticker, d);
  if (!tickerData.size) throw new Error('no ticker data');

  const monthMs = 30.44 * 24 * 3600 * 1000;
  const checkpointCount = Math.floor((YEARS * 365 - Math.max(...HORIZONS)) / 30.44);
  const latestT = Math.max(...[...tickerData.values()].map((d) => d.candles[d.candles.length - 1].t));

  const months = []; // [{monthKey, recs}]
  let totalSignals = 0;
  // SPY lookup helper (binary search over sorted closes)
  const spyAt = (t) => {
    let lo = 0, hi = spy.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (spy[mid].t >= t) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans >= 0 ? spy[ans] : null;
  };

  for (let k = checkpointCount; k >= 1; k--) {
    const checkpointT = latestT - k * monthMs;
    const monthKey = new Date(checkpointT).toISOString().slice(0, 7);
    const snaps = [];
    for (const [ticker, d] of tickerData) {
      const idx = d.candles.findIndex((c) => c.t >= checkpointT);
      if (idx < 0 || idx < 253) continue; // 253 closes: SMA200 warmup + 12-1 momentum
      const c0 = d.candles[idx];
      const slice = d.candles.slice(0, idx + 1);
      const closes = slice.map((c) => c.close);
      const fundamentals = buildFundamentalsAsOf(d.facts, c0.t);
      if (fundamentals.epsDiluted && fundamentals.epsDiluted > 0) fundamentals.peRatio = c0.close / fundamentals.epsDiluted;
      snaps.push({ ticker, d, idx, c0, slice, closes, fundamentals, sector: d.sector });
    }
    if (snaps.length < RANK_MIN_UNIVERSE) continue;

    const pctResults = {
      growth: crossPercentiles(snaps, (s) => s.fundamentals?.revenueGrowthYoY),
      margin: crossPercentiles(snaps, (s) => s.fundamentals?.netMargin),
      roe: crossPercentiles(snaps, (s) => s.fundamentals?.roe),
      pe: crossPercentiles(snaps, (s) => s.fundamentals?.peRatio),
    };

    const recs = [];
    for (const s of snaps) {
      const sectorPercentiles = {};
      for (const key of Object.keys(pctResults)) {
        const p = pctResults[key].get(s.ticker);
        if (p !== undefined) sectorPercentiles[key] = p;
      }
      const raw = rawBlockPoints({ price: s.c0.close, closes: s.closes, fundamentals: s.fundamentals, sectorPercentiles });
      // forward outcomes at every horizon
      const fwds = {};
      let ok = true;
      const s0 = spyAt(s.c0.t);
      if (!s0) continue;
      for (const h of HORIZONS) {
        const exitIdx = s.d.candles.findIndex((c) => c.t >= s.c0.t + h * DAY_MS);
        if (exitIdx < 0) { ok = false; break; }
        const c1 = s.d.candles[exitIdx];
        const s1 = spyAt(c1.t);
        if (!s1) { ok = false; break; }
        fwds[h] = {
          fwd: ((c1.close - s.c0.close) / s.c0.close) * 100,
          spyFwd: ((s1.c - s0.c) / s0.c) * 100,
        };
      }
      if (!ok) continue;
      recs.push({ ticker: s.ticker, raw, fwds });
      totalSignals++;
    }
    if (recs.length) months.push({ monthKey, recs });
  }
  months.sort((a, b) => (a.monthKey < b.monthKey ? -1 : 1));
  return { months, totalSignals };
}

// ============================ variant scoring ============================
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Effective momentum points under a damping variant (±10 raw block). */
function momentumPoints(raw, damp) {
  if (raw.momRaw == null) return null;
  if (!damp) return clamp(raw.momRaw, -MOM_BLOCK_MAX, MOM_BLOCK_MAX);
  const rD = damp.window === 5 ? raw.r5 : raw.r21;
  if (!Number.isFinite(rD)) return clamp(raw.momRaw, -MOM_BLOCK_MAX, MOM_BLOCK_MAX);
  const dampPts = damp.lambda * clamp(rD * DAMP_POINT_SCALE, -MOM_BLOCK_MAX, MOM_BLOCK_MAX);
  return clamp(raw.momRaw - dampPts, -MOM_BLOCK_MAX, MOM_BLOCK_MAX);
}

/** Unrounded v3 score under a variant (renormalized to the 110 scale). */
function scoreRaw(raw, variant) {
  const wSum = FACTOR_WEIGHTS.trend + FACTOR_WEIGHTS.rsi + FACTOR_WEIGHTS.fund + FACTOR_WEIGHTS.mom + FACTOR_WEIGHTS.sent;
  const scale = TOTAL_SCALE / wSum;
  const momEff = momentumPoints(raw, variant.damp);
  let s = 0;
  if (FACTOR_WEIGHTS.rsi) s += (FACTOR_WEIGHTS.rsi / FACTOR_CAPS.rsi) * raw.rsiPts;
  if (FACTOR_WEIGHTS.mom && momEff != null) s += (FACTOR_WEIGHTS.mom / FACTOR_CAPS.mom) * momEff;
  // trend/fund weights are 0; sentiment raw = 0 in the backtest
  return s * scale;
}

function actionFor(score, raw, variant, rounded) {
  let s = score;
  if (rounded) s = Math.round(clamp(s, -100, 100)); // EXACT live-engine arithmetic
  let action = 'HOLD';
  if (s >= 35) action = 'BUY';
  else if (s < -15 && raw.bearishVotes >= 2) action = 'SELL';
  if (action === 'BUY' && variant.gate) {
    const rD = variant.gate.window === 5 ? raw.r5 : raw.r21;
    if (Number.isFinite(rD) && rD * 100 > variant.gate.threshold) action = 'HOLD';
  }
  return action;
}

/** Evaluate one variant: per-month rank metrics at 90d + BUY alpha per horizon. */
function evaluateVariant(months, variant, rounded) {
  const perMonth = [];
  const buyByTicker = {}; // horizon -> ticker -> {fwd:[], spy:[]}
  for (const h of HORIZONS) buyByTicker[h] = {};
  const monthBuyAlpha = {}; // horizon -> [] (per-month mean BUY alpha, signal-level, for half-splits)
  for (const h of HORIZONS) monthBuyAlpha[h] = [];
  const gateDemotions = { total: 0 };
  for (const { monthKey, recs } of months) {
    if (recs.length < RANK_MIN_UNIVERSE) continue;
    const scored = recs.map((r) => {
      const score = scoreRaw(r.raw, variant);
      const action = actionFor(score, r.raw, variant, rounded);
      if (action === 'BUY') {
        for (const h of HORIZONS) {
          const k = r.ticker;
          if (!buyByTicker[h][k]) buyByTicker[h][k] = { fwd: [], spy: [] };
          buyByTicker[h][k].fwd.push(r.fwds[h].fwd);
          buyByTicker[h][k].spy.push(r.fwds[h].spyFwd);
        }
      } else if (variant.gate) {
        const rD = variant.gate.window === 5 ? r.raw.r5 : r.raw.r21;
        const scoreNoGate = actionFor(score, r.raw, { ...variant, gate: null }, rounded);
        if (scoreNoGate === 'BUY' && Number.isFinite(rD) && rD * 100 > variant.gate.threshold) gateDemotions.total++;
      }
      const alpha90 = r.fwds[90].fwd - r.fwds[90].spyFwd;
      return { ticker: r.ticker, score, alpha: alpha90, fwd: r.fwds[90].fwd, action, fwds: r.fwds };
    });
    scored.sort((a, b) => a.score - b.score || (a.ticker < b.ticker ? -1 : 1));
    const qAlpha = [[], [], [], [], []];
    scored.forEach((rec, pos) => {
      qAlpha[quintileOf(pos, scored.length) - 1].push(rec.alpha);
    });
    const meanAlpha = qAlpha.map((a) => avg(a));
    const sp = spearman([1, 2, 3, 4, 5], meanAlpha);
    for (const h of HORIZONS) {
      const buys = scored.filter((r) => r.action === 'BUY');
      if (buys.length) monthBuyAlpha[h].push(avg(buys.map((r) => r.fwds[h].fwd - r.fwds[h].spyFwd)));
    }
    perMonth.push({
      monthKey,
      spearmanAlpha: sp == null ? null : sp,
      topMinusMid: meanAlpha[4] - meanAlpha[2],
      topAboveMid: meanAlpha[4] > meanAlpha[2],
    });
  }
  const spVals = perMonth.map((m) => m.spearmanAlpha).filter((v) => v != null);
  const half = Math.floor(perMonth.length / 2);
  const halfSp = (arr) => {
    const v = arr.map((m) => m.spearmanAlpha).filter((x) => x != null);
    return v.length ? avg(v) : null;
  };
  const buyStats = {};
  for (const h of HORIZONS) {
    const alphas = Object.values(buyByTicker[h]).map((s) => avg(s.fwd) - avg(s.spy));
    const ci = bootstrapCi(alphas);
    buyStats[h] = {
      tickers: alphas.length,
      alphaMean: alphas.length ? avg(alphas) : null,
      ci95: ci ? [ci.lo, ci.hi] : null,
    };
  }
  const halfBuy = {};
  for (const h of HORIZONS) {
    const arr = monthBuyAlpha[h];
    const half = Math.floor(arr.length / 2);
    halfBuy[h] = { first: arr.length ? avg(arr.slice(0, half)) : null, second: arr.length ? avg(arr.slice(half)) : null };
  }
  return {
    id: variant.id,
    rounded,
    monthsTested: perMonth.length,
    avgSpearman: spVals.length ? avg(spVals) : null,
    avgTopMinusMid: perMonth.length ? avg(perMonth.map((m) => m.topMinusMid)) : null,
    firstHalfSpearman: halfSp(perMonth.slice(0, half)),
    secondHalfSpearman: halfSp(perMonth.slice(half)),
    buy: buyStats,
    buyHalves: halfBuy,
    gateDemotions: variant.gate ? gateDemotions.total : 0,
  };
}

// ======================= task-1 profiling (baseline) =======================
function profileReversal(months) {
  const baseline = VARIANTS[0];
  // pooled quintile alpha per horizon
  const pooled = {}; // horizon -> [q1..q5] alpha arrays
  for (const h of HORIZONS) pooled[h] = [[], [], [], [], []];
  const perMonthBuy = []; // {monthKey, n, alpha5, alpha21, alpha90, gateShare}
  const buyByR5 = {}; // prior-5d-return bucket -> horizon -> alpha arrays
  const R5_BUCKETS = [
    { id: 'r5<=0', test: (r) => r <= 0 },
    { id: 'r5 0..4%', test: (r) => r > 0 && r <= 4 },
    { id: 'r5 4..8%', test: (r) => r > 4 && r <= 8 },
    { id: 'r5 >8%', test: (r) => r > 8 },
  ];
  for (const b of R5_BUCKETS) buyByR5[b.id] = {};
  for (const h of HORIZONS) for (const b of R5_BUCKETS) buyByR5[b.id][h] = [];

  for (const { monthKey, recs } of months) {
    if (recs.length < RANK_MIN_UNIVERSE) continue;
    const scored = recs.map((r) => {
      const score = scoreRaw(r.raw, baseline);
      const action = actionFor(score, r.raw, baseline, false);
      return { ticker: r.ticker, score, action, raw: r.raw, fwds: r.fwds };
    });
    scored.sort((a, b) => a.score - b.score || (a.ticker < b.ticker ? -1 : 1));
    scored.forEach((rec, pos) => {
      const q = quintileOf(pos, scored.length) - 1;
      for (const h of HORIZONS) pooled[h][q].push(rec.fwds[h].fwd - rec.fwds[h].spyFwd);
    });
    const buys = scored.filter((r) => r.action === 'BUY');
    if (buys.length) {
      const m = { monthKey, n: buys.length };
      for (const h of HORIZONS) {
        m[`alpha${h}`] = avg(buys.map((r) => r.fwds[h].fwd - r.fwds[h].spyFwd));
        m[`fwd${h}`] = avg(buys.map((r) => r.fwds[h].fwd));
      }
      m.gateShareOver8 = (100 * buys.filter((r) => Number.isFinite(r.raw.r5) && r.raw.r5 * 100 > 8).length) / buys.length;
      perMonthBuy.push(m);
      for (const b of R5_BUCKETS) {
        const grp = buys.filter((r) => Number.isFinite(r.raw.r5) && b.test(r.raw.r5 * 100));
        for (const h of HORIZONS) if (grp.length) buyByR5[b.id][h].push(...grp.map((r) => r.fwds[h].fwd - r.fwds[h].spyFwd));
      }
    }
  }
  const halfIdx = Math.floor(perMonthBuy.length / 2);
  const halfStats = (arr, key) => {
    const h1 = arr.slice(0, halfIdx), h2 = arr.slice(halfIdx);
    return { firstHalf: avg(h1.map((m) => m[key])), secondHalf: avg(h2.map((m) => m[key])) };
  };
  return {
    pooledQuintileAlpha: Object.fromEntries(HORIZONS.map((h) => [h, pooled[h].map((a) => r2(avg(a)))])),
    buyByPriorR5: Object.fromEntries(R5_BUCKETS.map((b) => [b.id, Object.fromEntries(HORIZONS.map((h) => [h, { n: buyByR5[b.id][h].length, meanAlpha: r2(avg(buyByR5[b.id][h])) }]))])),
    perMonthBuy: perMonthBuy.map((m) => ({ ...m, alpha5: r2(m.alpha5), alpha21: r2(m.alpha21), alpha90: r2(m.alpha90), fwd5: r2(m.fwd5), fwd21: r2(m.fwd21), fwd90: r2(m.fwd90), gateShareOver8: +m.gateShareOver8.toFixed(1) })),
    buyAlphaHalves: Object.fromEntries(HORIZONS.map((h) => [h, Object.fromEntries(Object.entries(halfStats(perMonthBuy, `alpha${h}`)).map(([k, v]) => [k, r2(v)]))])),
  };
}

// ================================ main ================================
async function main() {
  const data = await loadData();
  console.log('Building checkpoint table (fetch done — variants are pure arithmetic)...');
  const { months, totalSignals } = buildCheckpoints(data);
  console.log(`Checkpoints: ${months.length} months, ${totalSignals} scored observations`);

  // ---- Task 1: profile the reversal on the baseline ----
  const profile = profileReversal(months);
  console.log('\n===== TASK 1: where the reversal lives (baseline v3, unrounded) =====');
  for (const h of HORIZONS) {
    console.log(`Pooled quintile mean alpha ${h}d (Q1=worst → Q5=best scores): ${profile.pooledQuintileAlpha[h].map((v, i) => `Q${i + 1} ${v > 0 ? '+' : ''}${v}%`).join(' | ')}`);
  }
  console.log('BUY signals by prior-5d return bucket (mean alpha %):');
  for (const [id, byH] of Object.entries(profile.buyByPriorR5)) {
    console.log(`  ${id.padEnd(9)} | 5d ${byH[5].meanAlpha ?? 'n/a'} (n=${byH[5].n}) | 21d ${byH[21].meanAlpha ?? 'n/a'} (n=${byH[21].n}) | 90d ${byH[90].meanAlpha ?? 'n/a'} (n=${byH[90].n})`);
  }
  console.log(`BUY alpha halves (first/second): 5d ${profile.buyAlphaHalves[5].firstHalf}/${profile.buyAlphaHalves[5].secondHalf} | 21d ${profile.buyAlphaHalves[21].firstHalf}/${profile.buyAlphaHalves[21].secondHalf}`);

  // ---- Task 2: variant grid ----
  const results = [];
  for (const v of VARIANTS) {
    const unrounded = evaluateVariant(months, v, false);
    const exact = evaluateVariant(months, v, true);
    results.push({ variant: v, unrounded, exact });
    const b21u = unrounded.buy[21];
    console.log(`[${v.id}] 90d Spearman ${r3(unrounded.avgSpearman)} (H1 ${r3(unrounded.firstHalfSpearman)} / H2 ${r3(unrounded.secondHalfSpearman)}) | top−mid ${r2(unrounded.avgTopMinusMid)} | BUY21d α ${r2(b21u.alphaMean)} [${b21u.ci95?.map(r2).join(', ')}] | BUY5d α ${r2(unrounded.buy[5].alphaMean)} | BUY90d α ${r2(unrounded.buy[90].alphaMean)}${v.gate ? ` | demoted ${unrounded.gateDemotions}` : ''}`);
  }

  // ---- adoption table ----
  const base = results.find((r) => r.variant.id === 'baseline').unrounded;
  const baseExact = results.find((r) => r.variant.id === 'baseline').exact;
  const adoption = results.map((r) => {
    const u = r.unrounded, e = r.exact;
    const improves21 = (u.buy[21].alphaMean ?? -9) > (base.buy[21].alphaMean ?? -9);
    const improves21Halves = (u.buyHalves[21].first ?? -9) > (base.buyHalves[21].first ?? -9)
      && (u.buyHalves[21].second ?? -9) > (base.buyHalves[21].second ?? -9);
    const spearmanKept = (u.avgSpearman ?? -9) >= (base.avgSpearman ?? -9) - 0.03
      && (e.avgSpearman ?? -9) >= (baseExact.avgSpearman ?? -9) - 0.03;
    return {
      id: r.variant.id,
      label: r.variant.label,
      spearman90: { unrounded: r3(u.avgSpearman), exact: r3(e.avgSpearman), h1: r3(u.firstHalfSpearman), h2: r3(u.secondHalfSpearman) },
      topMinusMid: r2(u.avgTopMinusMid),
      buyAlpha: {
        '5d': { mean: r2(u.buy[5].alphaMean), ci: u.buy[5].ci95?.map(r2), baselineMean: r2(base.buy[5].alphaMean), improves: (u.buy[5].alphaMean ?? -9) > (base.buy[5].alphaMean ?? -9) },
        '21d': { mean: r2(u.buy[21].alphaMean), ci: u.buy[21].ci95?.map(r2), baselineMean: r2(base.buy[21].alphaMean), improves: improves21 },
        '90d': { mean: r2(u.buy[90].alphaMean), ci: u.buy[90].ci95?.map(r2), baselineMean: r2(base.buy[90].alphaMean), improves: (u.buy[90].alphaMean ?? -9) > (base.buy[90].alphaMean ?? -9) },
      },
      bothHalvesPositiveSpearman: (u.firstHalfSpearman ?? -1) > 0 && (u.secondHalfSpearman ?? -1) > 0 && (e.firstHalfSpearman ?? -1) > 0 && (e.secondHalfSpearman ?? -1) > 0,
      spearmanKept,
      gateDemotions: u.gateDemotions,
      improves21Halves,
    };
  });

  const doc = {
    generatedAt: new Date().toISOString(),
    config: { years: YEARS, top: TOP, horizons: HORIZONS, variants: VARIANTS.map((v) => v.id), dampPointScale: DAMP_POINT_SCALE, dataCache: CACHE_PATTERN(TOP), signals: totalSignals, checkpoints: months.length, bootstrap: { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED } },
    profile,
    baseline: { unrounded: summarize(base), exact: summarize(baseExact) },
    variants: results.map((r) => ({ id: r.variant.id, label: r.variant.label, damp: r.variant.damp, gate: r.variant.gate, unrounded: summarize(r.unrounded), exact: summarize(r.exact) })),
    adoption,
  };
  function summarize(x) {
    return {
      monthsTested: x.monthsTested,
      avgSpearman: r3(x.avgSpearman),
      avgTopMinusMid: r2(x.avgTopMinusMid),
      firstHalfSpearman: r3(x.firstHalfSpearman),
      secondHalfSpearman: r3(x.secondHalfSpearman),
      buy: Object.fromEntries(HORIZONS.map((h) => [h, { tickers: x.buy[h].tickers, alphaMean: r2(x.buy[h].alphaMean), ci95: x.buy[h].ci95?.map(r2) }])),
      buyHalves: Object.fromEntries(HORIZONS.map((h) => [h, { first: r2(x.buyHalves[h].first), second: r2(x.buyHalves[h].second) }])),
      gateDemotions: x.gateDemotions,
    };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));

  // ---- markdown summary ----
  const rows = doc.variants.map((v) => {
    const u = v.unrounded;
    return `| ${v.label} | ${u.avgSpearman} | ${r2(u.firstHalfSpearman)} / ${r2(u.secondHalfSpearman)} | ${r2(u.avgTopMinusMid)} | ${u.buy[5].alphaMean} [${u.buy[5].ci95?.join(', ')}] | ${u.buy[21].alphaMean} [${u.buy[21].ci95?.join(', ')}] | ${u.buy[90].alphaMean} | ${v.id === 'baseline' ? '**baseline**' : ''} |`;
  }).join('\n');
  const md = `# Short-horizon reversal lab — ${doc.generatedAt}

Config: ${YEARS}y backtest, top ${TOP} universe, ${months.length} months × ${totalSignals} observations, horizons 5/21/90d. Methodology identical to scripts/weight-search.mjs (same pipeline, same cluster-robust bootstrap: ticker-level alpha means, 1000 draws, seed 42). Baseline = shipped engine v3 (trend 0 / rsi 5 / fund 0 / mom 20 / sent 25). Scores unrounded unless noted; engine-exact rounded metrics in data/reversal-lab.json.

## Task 1 — where the reversal lives
Pooled quintile mean alpha (Q1=worst → Q5=best engine scores):
| horizon | Q1 | Q2 | Q3 | Q4 | Q5 |
|---|---|---|---|---|---|
${HORIZONS.map((h) => `| ${h}d | ${profile.pooledQuintileAlpha[h].join(' | ')} |`).join('\n')}

BUY signals by prior-5d return bucket (mean alpha %, ticker-level):
| bucket | 5d | 21d | 90d |
|---|---|---|---|
${Object.entries(profile.buyByPriorR5).map(([id, byH]) => `| ${id} | ${byH[5].meanAlpha} (n=${byH[5].n}) | ${byH[21].meanAlpha} (n=${byH[21].n}) | ${byH[90].meanAlpha} (n=${byH[90].n}) |`).join('\n')}

BUY alpha halves (first / second half of the sample): 5d ${profile.buyAlphaHalves[5].firstHalf} / ${profile.buyAlphaHalves[5].secondHalf} | 21d ${profile.buyAlphaHalves[21].firstHalf} / ${profile.buyAlphaHalves[21].secondHalf} | 90d ${profile.buyAlphaHalves[90].firstHalf} / ${profile.buyAlphaHalves[90].secondHalf}

Per-month BUY alpha is in data/reversal-lab.json (profile.perMonthBuy).

## Task 2 — variant grid (BUY alpha = ticker-level mean [CI95], gross of costs)
| variant | 90d Spearman | H1 / H2 | top−mid | BUY 5d α | BUY 21d α | BUY 90d α | note |
|---|---|---|---|---|---|---|---|
${rows}

## Adoption criteria (as specified)
- Winner holds 90d Spearman sign in BOTH halves (unrounded AND engine-exact).
- Improves 21d BUY alpha vs baseline.
- Does not destroy 90d Spearman (within −0.03 of baseline, both scorers).
${adoption.filter((a) => a.id !== 'baseline').map((a) => `- ${a.id}: halves-positive=${a.bothHalvesPositiveSpearman}, 21d improves=${a.buyAlpha['21d'].improves} (${a.buyAlpha['21d'].baselineMean} → ${a.buyAlpha['21d'].mean}), 90d Spearman kept=${a.spearmanKept}`).join('\n')}
`;
  fs.mkdirSync(path.dirname(SUMMARY), { recursive: true });
  fs.writeFileSync(SUMMARY, md);
  console.log(`\nSaved: ${OUT}\nSaved: ${SUMMARY}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
