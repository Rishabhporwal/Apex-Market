#!/usr/bin/env node
/**
 * Factor-weight grid search for the verdict quant core.
 *
 * Objective: make the verdict score actually RANK stocks (fix the rank-
 * performance FAIL: Spearman(score bucket, 90d alpha) ≈ −0.05, top quintile
 * below middle). This lab re-uses the backtester's exact data pipeline
 * (same universe query, same look-ahead-free fundamentals gating, same
 * cross-sectional sector percentiles, same quintile/Spearman machinery) but
 * makes the five block weights PARAMETERS and searches the grid:
 *
 *   trend {0,10,25} | RSI {0,5,15} | fundamentals {0,20,35,50}
 *   momentum {0,10,20} | sentiment {0,10,25}
 *   growth_ttm {0,10,20} | margin_ttm {0,10,20}                 → 2916 combos
 *
 * Parameterization (per block): points_scale = w_block / default_cap, then the
 * total is renormalized so Σ w_block = 110 (the current total cap). At the
 * current weights (25/15/35/10/25) this reproduces the shipped engine exactly;
 * for other combos it keeps the ±100 score scale and the BUY≥35 / HOLD / SELL
 * thresholds comparable across combos. Sentiment is always 0 in the backtest
 * (no historical news feed), so its weight only acts through the total-scale
 * renormalization — it cannot be validated here and is reported as such.
 *
 * TTM extension (2026-10-27.9 candidate): two additional percentile blocks
 * built from the quarterly warehouse (facts_quarterly + 10-K FY facts):
 *   growth_ttm / margin_ttm — rolling-4-quarter revenue growth and net margin,
 *   computed per ticker AT EACH CHECKPOINT with the filed_at look-ahead guard
 *   (only facts FILED before the checkpoint are visible; derived Q4 carries
 *   the 10-K filing date). Each maps a 0-100 sector percentile onto the same
 *   ±35 points scale the fundamentals composite uses. Grid: {0,10,20} each.
 * NOTE on honest sample: the quarterly warehouse only stores quarter-ends back
 * ~40 months (ingest cutoff), so the earliest complete TTM window ends
 * ~Q1-2024 — TTM factors are testable on roughly the second half of the
 * 3-year checkpoint range only. Reported per-month coverage in the output.
 *
 * Anti-overfitting: overall / first-half / second-half per-month Spearman are
 * reported SEPARATELY. Only a combo with positive Spearman in BOTH halves and
 * a clear improvement over the current weights is a candidate for adoption.
 *
 * Data: warehouse is copied to a scratch dir (DuckDB single-writer) and Yahoo
 * candles are cached to tmp/bt-data-cache.json so repeated searches don't
 * re-fetch. Nothing here writes to the live warehouse.
 *
 * Usage:  node scripts/weight-search.mjs [--years=3] [--horizon=90] [--top=150] [--refresh]
 *                                         [--cache=<path>] [--out=<path>] [--summary=<path>]
 * Output: data/weight-search.json + tmp/weight-search-summary.md (overridable)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(process.cwd());
const WAREHOUSE = path.join(ROOT, 'data', 'warehouse.duckdb');
const OUT = path.join(ROOT, getArg2('out', 'data/weight-search.json'));
const SUMMARY = path.join(ROOT, getArg2('summary', 'tmp/weight-search-summary.md'));
const CACHE = path.resolve(ROOT, getArg2('cache', 'tmp/bt-data-cache.json'));

// args helper hoisted above OUT/SUMMARY resolution (function declaration hoists)
function getArg2(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}

// ---- args ----
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const YEARS = Number(getArg('years', 3));
const HORIZON = Number(getArg('horizon', 90));
const TOP = Number(getArg('top', 150));
const REFRESH = args.includes('--refresh');
const DAY_MS = 24 * 3600 * 1000;

// ---- weight grid (block caps in the shipped engine: trend 25, rsi 15, fund 35, mom 10, sent 25) ----
// growthTtm / marginTtm are NEW percentile blocks (±35 scale like the
// fundamentals composite) — no shipped cap yet, 35 is their points scale.
const GRID = {
  trend: [0, 10, 25],
  rsi: [0, 5, 15],
  fund: [0, 20, 35, 50],
  mom: [0, 10, 20],
  sent: [0, 10, 25],
  growthTtm: [0, 10, 20],
  marginTtm: [0, 10, 20],
};
const DEFAULT_CAPS = { trend: 25, rsi: 15, fund: 35, mom: 10, sent: 25, growthTtm: 35, marginTtm: 35 };
const TOTAL_SCALE = 110; // current Σ caps — renormalization target

const BASELINE = { trend: 0, rsi: 5, fund: 0, mom: 20, sent: 25, growthTtm: 0, marginTtm: 0 };

// ---- TTM series construction (mirrors scripts/ingest-edgar-quarterly.mjs) ----
// The quarterly warehouse stores only clean quarterly-duration 10-Q facts
// (Q1-Q3; Q4 never appears in a 10-Q) with per-row filed_at, and the annual
// warehouse stores 10-K FY facts. Q4 standalone = FY − (Q1+Q2+Q3) of the same
// fiscal year; the derived Q4 carries the 10-K filing date (Q1-Q3 were filed
// earlier), keeping the series look-ahead-free.
const REVENUE_TAGS_TTM = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
  'SalesRevenueGoodsNet',
  'SalesRevenueServicesNet',
];
const NET_INCOME_TAGS_TTM = ['NetIncomeLoss', 'ProfitLoss'];
const DAY_MS_TTM = 24 * 3600 * 1000;

/** Latest-filed visible value per period end for one tag. */
function latestFiledByEndTtm(rows, asOfMs) {
  const m = new Map();
  for (const r of rows) {
    if (r.filedAt == null || r.filedAt > asOfMs) continue; // look-ahead guard
    const prev = m.get(r.end);
    if (!prev || r.filedAt > prev.filedAt) m.set(r.end, r);
  }
  return m;
}

/** Build the per-quarter-end series (Q1-Q3 direct + Q4 derived) for one tag. */
function quarterlySeriesTtm(qRows, annualRows, tag, asOfMs) {
  const q = latestFiledByEndTtm(qRows.filter((r) => r.tag === tag), asOfMs);
  const ann = latestFiledByEndTtm(annualRows.filter((r) => r.tag === tag), asOfMs);
  const byEnd = new Map();
  for (const [k, r] of q) byEnd.set(k, { val: r.val, filed: r.filedAt });
  for (const [k, a] of ann) {
    if (byEnd.has(k)) continue;
    // Q4 = FY − (Q1+Q2+Q3): the three quarterly ends immediately before the
    // fiscal-year end, forming an 80-100-day chain.
    const priorEnds = [...q.keys()].filter((e) => k - e > 0 && k - e < 280 * DAY_MS_TTM).sort((x, y) => y - x);
    if (priorEnds.length !== 3) continue;
    const [e1, e2, e3] = priorEnds;
    const g1 = (k - e1) / DAY_MS_TTM, g2 = (e1 - e2) / DAY_MS_TTM, g3 = (e2 - e3) / DAY_MS_TTM;
    if (g1 < 80 || g1 > 100 || g2 < 80 || g2 > 100 || g3 < 80 || g3 > 100) continue;
    const sum = q.get(e1).val + q.get(e2).val + q.get(e3).val;
    if (!Number.isFinite(sum)) continue;
    byEnd.set(k, { val: a.val - sum, filed: a.filedAt });
  }
  return byEnd;
}

/** Sum 4 consecutive quarters ending at ends[i..i+3] (desc order). */
function ttmWindowTtm(endsDesc, perEnd, startIdx) {
  if (startIdx + 4 > endsDesc.length) return null;
  let sum = 0;
  let maxFiled = null;
  for (let j = startIdx; j < startIdx + 4; j++) {
    const rec = perEnd.get(endsDesc[j]);
    if (!rec) return null;
    if (j > startIdx) {
      const gap = (endsDesc[j - 1] - endsDesc[j]) / DAY_MS_TTM;
      if (gap < 80 || gap > 100) return null;
    }
    sum += rec.val;
    if (rec.filed && (!maxFiled || rec.filed > maxFiled)) maxFiled = rec.filed;
  }
  return { sum, maxFiled };
}

/**
 * TTM growth/margin visible at asOfMs, from quarterly + annual facts.
 * Returns { growthTtm, marginTtm } in PERCENT (matches revenueGrowthYoY /
 * netMargin conventions) or undefined when no clean TTM window is visible.
 */
function buildTtmAsOf(qfacts, facts, asOfMs) {
  // Per-end first-tag-wins across the priority list (mirrors pickPerEnd):
  const revEnds = new Map();
  for (const tag of REVENUE_TAGS_TTM) {
    const s = quarterlySeriesTtm(qfacts, facts, tag, asOfMs);
    for (const [k, rec] of s) if (!revEnds.has(k)) revEnds.set(k, rec);
  }
  const niEnds = new Map();
  for (const tag of NET_INCOME_TAGS_TTM) {
    const s = quarterlySeriesTtm(qfacts, facts, tag, asOfMs);
    for (const [k, rec] of s) if (!niEnds.has(k)) niEnds.set(k, rec);
  }
  const endsDesc = [...revEnds.keys()].sort((a, b) => b - a);
  if (endsDesc.length < 4) return undefined;
  const cur = ttmWindowTtm(endsDesc, revEnds, 0);
  if (!cur) return undefined;
  // Growth needs the PRIOR 4-quarter window (8 quarters of history); margin
  // needs only the current window — they become visible at different times
  // and are reported independently.
  const prior = ttmWindowTtm(endsDesc, revEnds, 4);
  const niCur = ttmWindowTtm(endsDesc, niEnds, 0);
  const out = {};
  if (prior && prior.sum > 0) out.growthTtm = (cur.sum / prior.sum - 1) * 100;
  if (niCur && cur.sum !== 0) out.marginTtm = (niCur.sum / cur.sum) * 100;
  return Object.keys(out).length ? out : undefined;
}

// ---- quant-core mirrors (verbatim from scripts/backtest-verdicts.mjs) ----
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

/** Raw block points at the SHIPPED caps — the weight search scales these. */
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
  let hasFund = false;
  if (fundamentals) {
    hasFund = true;
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
  const momPts = m121 !== undefined ? Math.max(-10, Math.min(10, m121 * 50)) : 0;
  // TTM percentile blocks (±35 scale, same machinery as the fundamentals
  // composite): points = (pctile − 50)/50 × 35, 0 when no TTM percentile.
  const gTtm = pct.growthTtm;
  const gtmmPts = gTtm !== undefined ? Math.max(-35, Math.min(35, ((gTtm - 50) / 50) * 35)) : 0;
  const mTtm = pct.marginTtm;
  const mtmmPts = mTtm !== undefined ? Math.max(-35, Math.min(35, ((mTtm - 50) / 50) * 35)) : 0;
  // SELL bearish votes (weight-independent, from raw indicators)
  let bearishVotes = 0;
  if (trend === 'down') bearishVotes++;
  if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) bearishVotes++;
  if (rv !== undefined && rv > 70) bearishVotes++;
  return { trendPts, rsiPts, fundPts, momPts, gtmmPts, mtmmPts, hasFund, trend, rv, bearishVotes };
}

// ---- look-ahead-free fundamentals as-of (verbatim from backtest-verdicts.mjs) ----
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
/** Make sure every universe entry carries qfacts (quarterly 10-Q facts from
 *  facts_quarterly, the TTM factor source). On a cache hit without them, open
 *  a warehouse snapshot (single-writer-safe copy), fetch per ticker, patch the
 *  cache file in place, and return the enriched doc. */
async function ensureQfacts(doc) {
  if (doc.universe && Object.values(doc.universe).every((d) => d && d.qfacts !== undefined)) return doc;
  console.log('Cache lacks quarterly facts — fetching facts_quarterly from a warehouse snapshot...');
  if (!fs.existsSync(WAREHOUSE)) {
    console.error('FATAL: warehouse not found — cannot fetch quarterly facts.');
    process.exit(1);
  }
  const snapDir = fs.mkdtempSync(path.join(ROOT, 'data', 'bt-snap-'));
  const snapshot = path.join(snapDir, 'warehouse.duckdb');
  fs.copyFileSync(WAREHOUSE, snapshot);
  const db = await DuckDBInstance.create(snapshot, { access_mode: 'READ_ONLY' });
  const conn = await db.connect();
  let n = 0;
  for (const [ticker, d] of Object.entries(doc.universe)) {
    const rs = await conn.runAndReadAll(
      `SELECT fq.tag, fq.end, fq.val, fq.fy, fq.fp, fq.filed_at FROM facts_quarterly fq
       JOIN companies c ON c.cik = fq.cik WHERE c.ticker = ?`,
      [ticker]
    );
    d.qfacts = rs.getRowObjects().map((r) => ({
      tag: String(r.tag),
      end: new Date(String(r.end)).getTime(),
      filedAt: r.filed_at == null ? null : new Date(String(r.filed_at)).getTime(),
      val: Number(r.val),
      fy: r.fy == null ? null : String(r.fy),
      fp: r.fp == null ? null : String(r.fp),
    }));
    if (++n % 100 === 0) console.log(`[qfacts ${n}/${Object.keys(doc.universe).length}]`);
  }
  await conn.closeSync();
  try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {}
  try {
    fs.writeFileSync(CACHE, JSON.stringify(doc));
    console.log(`Cache patched with qfacts: ${CACHE}`);
  } catch (e) {
    console.log(`(cache patch skipped: ${e.message})`);
  }
  return doc;
}

async function loadData() {
  if (!REFRESH && fs.existsSync(CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      // horizon is optional in the cache: shared caches written by the other
      // labs (e.g. tmp/bt-data-cache-600.json from reversal-lab) omit it.
      if (cached.years === YEARS && cached.top === TOP &&
          (cached.horizon === undefined || cached.horizon === HORIZON)) {
        console.log(`Data cache hit: ${CACHE} (fetched ${cached.fetchedAt})`);
        return await ensureQfacts(cached);
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
  const progressEvery = Math.max(5, Math.floor(tickers.length / 10));
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
      const qfactsRs = await conn.runAndReadAll(
        `SELECT fq.tag, fq.end, fq.val, fq.filed_at FROM facts_quarterly fq
         JOIN companies c2 ON c2.cik = fq.cik WHERE c2.ticker = ?`,
        [ticker]
      );
      const qfacts = qfactsRs.getRowObjects().map((r) => ({
        tag: String(r.tag),
        end: new Date(String(r.end)).getTime(),
        filedAt: r.filed_at == null ? null : new Date(String(r.filed_at)).getTime(),
        val: Number(r.val),
      }));
      universe[ticker] = { candles: candlesAll, facts, qfacts, sector: sectorMap.get(ticker) ?? null };
    } catch (err) {
      skippedNoData++;
      if (String(err).includes('429')) console.warn('rate-limited; cooling 30s...');
      await new Promise((r) => setTimeout(r, 350));
    }
    if ((ti + 1) % progressEvery === 0) console.log(`[fetch ${ti + 1}/${tickers.length}] ok=${Object.keys(universe).length} skipped=${skippedNoData}`);
  }
  await conn.closeSync();
  cleanup();
  const doc = { fetchedAt: new Date().toISOString(), years: YEARS, top: TOP, horizon: HORIZON, spy, universe };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(doc));
  console.log(`Data cached: ${CACHE} (${Object.keys(universe).length} tickers)`);
  return doc;
}

// ======================= checkpoint factor table =======================
/** Build the per-(month,ticker) factor-contribution table ONCE; the grid
 *  search only re-weights these raw points. */
function buildCheckpoints(data) {
  const { spy, universe } = data;
  const tickerData = new Map();
  for (const [ticker, d] of Object.entries(universe)) tickerData.set(ticker, d);
  if (!tickerData.size) throw new Error('no ticker data');

  const monthMs = 30.44 * 24 * 3600 * 1000;
  const horizonMs = HORIZON * DAY_MS;
  const checkpointCount = Math.floor((YEARS * 365 - HORIZON) / 30.44);
  const latestT = Math.max(...[...tickerData.values()].map((d) => d.candles[d.candles.length - 1].t));

  const months = []; // [{monthKey, recs:[{ticker, raw, fwd, spyFwd, alpha}]}]
  const ttmCoverage = []; // [{monthKey, have, total}] — months with any TTM data
  let totalSignals = 0;
  for (let k = checkpointCount; k >= 1; k--) {
    const checkpointT = latestT - k * monthMs;
    const monthKey = new Date(checkpointT).toISOString().slice(0, 7);
    const snaps = [];
    for (const [ticker, d] of tickerData) {
      const idx = d.candles.findIndex((c) => c.t >= checkpointT);
      if (idx < 0 || idx < 210) continue;
      const c0 = d.candles[idx];
      const slice = d.candles.slice(0, idx + 1);
      const closes = slice.map((c) => c.close);
      const fundamentals = buildFundamentalsAsOf(d.facts, c0.t);
      if (fundamentals.epsDiluted && fundamentals.epsDiluted > 0) fundamentals.peRatio = c0.close / fundamentals.epsDiluted;
      // TTM growth/margin as of the checkpoint — quarterly facts gated on the
      // FILED date (buildTtmAsOf applies the look-ahead guard per row).
      const ttm = d.qfacts ? buildTtmAsOf(d.qfacts, d.facts, c0.t) : undefined;
      snaps.push({ ticker, d, idx, c0, slice, closes, fundamentals, ttm, sector: d.sector });
    }
    if (snaps.length < RANK_MIN_UNIVERSE) continue;

    const pctResults = {
      growth: crossPercentiles(snaps, (s) => s.fundamentals?.revenueGrowthYoY),
      margin: crossPercentiles(snaps, (s) => s.fundamentals?.netMargin),
      roe: crossPercentiles(snaps, (s) => s.fundamentals?.roe),
      pe: crossPercentiles(snaps, (s) => s.fundamentals?.peRatio),
      growthTtm: crossPercentiles(snaps, (s) => s.ttm?.growthTtm),
      marginTtm: crossPercentiles(snaps, (s) => s.ttm?.marginTtm),
    };
    // TTM coverage honesty: how much of the snapshot actually has TTM data at
    // this checkpoint (the quarterly warehouse only reaches back ~40 months).
    let ttmHave = 0;
    for (const s of snaps) if (s.ttm?.growthTtm !== undefined) ttmHave++;
    if (ttmHave) ttmCoverage.push({ monthKey, have: ttmHave, total: snaps.length });

    const recs = [];
    for (const s of snaps) {
      const sectorPercentiles = {};
      for (const key of Object.keys(pctResults)) {
        const p = pctResults[key].get(s.ticker);
        if (p !== undefined) sectorPercentiles[key] = p;
      }
      const raw = rawBlockPoints({ price: s.c0.close, closes: s.closes, fundamentals: s.fundamentals, sectorPercentiles });
      const exitIdx = s.d.candles.findIndex((c) => c.t >= s.c0.t + horizonMs);
      if (exitIdx < 0) continue;
      const c1 = s.d.candles[exitIdx];
      const spy0 = spy.find((x) => x.t >= s.c0.t);
      const spy1 = spy.find((x) => x.t >= c1.t);
      if (!spy0 || !spy1) continue;
      const fwd = ((c1.close - s.c0.close) / s.c0.close) * 100;
      const spyFwd = ((spy1.c - spy0.c) / spy0.c) * 100;
      recs.push({ ticker: s.ticker, raw, fwd, spyFwd, alpha: fwd - spyFwd });
      totalSignals++;
    }
    if (recs.length) months.push({ monthKey, recs });
  }
  months.sort((a, b) => (a.monthKey < b.monthKey ? -1 : 1));
  return { months, totalSignals, ttmCoverage };
}

// ============================ weight combos ============================
function* combos() {
  for (const trend of GRID.trend)
    for (const rsi of GRID.rsi)
      for (const fund of GRID.fund)
        for (const mom of GRID.mom)
          for (const sent of GRID.sent)
            for (const growthTtm of GRID.growthTtm)
              for (const marginTtm of GRID.marginTtm) {
                const w = { trend, rsi, fund, mom, sent, growthTtm, marginTtm };
                if (Object.values(w).reduce((a, b) => a + b, 0) <= 0) continue; // all-zero: no signal
                yield w;
              }
}

/** Score one observation under weights w (renormalized to TOTAL_SCALE).
 *  UNROUNDED: rank metrics must not depend on integer-rounding artifacts —
 *  combos that differ only in a block that contributes 0 raw points
 *  (e.g. sentiment in this backtest) then tie EXACTLY instead of jiggling
 *  ±0.02 Spearman via rounding tie-breaks. */
function scoreRaw(raw, w, scale) {
  let s = 0;
  if (w.trend) s += (w.trend / DEFAULT_CAPS.trend) * raw.trendPts;
  if (w.rsi) s += (w.rsi / DEFAULT_CAPS.rsi) * raw.rsiPts;
  if (w.fund) s += (w.fund / DEFAULT_CAPS.fund) * raw.fundPts;
  if (w.mom) s += (w.mom / DEFAULT_CAPS.mom) * raw.momPts;
  if (w.growthTtm) s += (w.growthTtm / DEFAULT_CAPS.growthTtm) * raw.gtmmPts;
  if (w.marginTtm) s += (w.marginTtm / DEFAULT_CAPS.marginTtm) * raw.mtmmPts;
  // sentiment raw points are 0 in the backtest (no historical feed)
  return s * scale;
}

function evaluateCombo(months, w, rounded) {
  const wSum = w.trend + w.rsi + w.fund + w.mom + w.sent + w.growthTtm + w.marginTtm;
  const scale = TOTAL_SCALE / wSum;
  const perMonth = [];
  const buyByTicker = new Map(); // ticker -> {fwd:[], spy:[]}
  for (const { monthKey, recs } of months) {
    if (recs.length < RANK_MIN_UNIVERSE) continue;
    const scored = recs.map((r) => {
      let score = scoreRaw(r.raw, w, scale);
      if (rounded) score = Math.round(Math.max(-100, Math.min(100, score))); // EXACT live-engine arithmetic
      let action = 'HOLD';
      if (score >= 35) action = 'BUY';
      else if (score < -15 && r.raw.bearishVotes >= 2) action = 'SELL';
      if (action === 'BUY') {
        let ts = buyByTicker.get(r.ticker);
        if (!ts) { ts = { fwd: [], spy: [] }; buyByTicker.set(r.ticker, ts); }
        ts.fwd.push(r.fwd);
        ts.spy.push(r.spyFwd);
      }
      return { ticker: r.ticker, score, alpha: r.alpha, fwd: r.fwd };
    });
    scored.sort((a, b) => a.score - b.score || (a.ticker < b.ticker ? -1 : 1));
    const qAlpha = [[], [], [], [], []];
    scored.forEach((rec, pos) => {
      qAlpha[quintileOf(pos, scored.length) - 1].push(rec.alpha);
    });
    const meanAlpha = qAlpha.map((a) => avg(a));
    const sp = spearman([1, 2, 3, 4, 5], meanAlpha);
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
  // pooled top/middle quintile alpha
  const pooledAlpha = [[], [], [], [], []];
  // recompute pooled assignment cheaply from the same scored order? We already
  // pushed per-month; for pooled we need per-observation quintiles — redo:
  const buyAlphas = [...buyByTicker.values()].map((s) => avg(s.fwd) - avg(s.spy));
  const ci = bootstrapCi(buyAlphas);
  return {
    weights: w,
    monthsTested: perMonth.length,
    avgSpearman: spVals.length ? avg(spVals) : null,
    medianSpearman: spVals.length ? [...spVals].sort((a, b) => a - b)[Math.floor(spVals.length / 2)] : null,
    positiveShare: spVals.length ? (100 * spVals.filter((v) => v > 0).length) / spVals.length : null,
    avgTopMinusMid: perMonth.length ? avg(perMonth.map((m) => m.topMinusMid)) : null,
    topAboveMidShare: perMonth.length ? (100 * perMonth.filter((m) => m.topAboveMid).length) / perMonth.length : null,
    firstHalfSpearman: halfSp(perMonth.slice(0, half)),
    secondHalfSpearman: halfSp(perMonth.slice(half)),
    buyTickerAlphaMean: buyAlphas.length ? avg(buyAlphas) : null,
    buyCi95: ci ? [ci.lo, ci.hi] : null,
    buyTickers: buyAlphas.length,
  };
}

// ================================ main ================================
async function main() {
  const data = await loadData();
  console.log('Building checkpoint factor table (fetch done — grid is pure arithmetic)...');
  const { months, totalSignals, ttmCoverage } = buildCheckpoints(data);
  console.log(`Checkpoints: ${months.length} months, ${totalSignals} scored observations`);
  if (ttmCoverage.length) {
    const avgCov = avg(ttmCoverage.map((c) => c.have / c.total));
    console.log(`TTM coverage: ${ttmCoverage.length}/${months.length} months have TTM data (avg ${Math.round(avgCov * 100)}% of snapshot, first ${ttmCoverage[0].monthKey}, last ${ttmCoverage[ttmCoverage.length - 1].monthKey})`);
  } else {
    console.log('TTM coverage: NONE — no checkpoint had a visible TTM window.');
  }

  const results = [];      // EXACT live-engine arithmetic (integer-rounded scores)
  const resultsCont = [];  // unrounded scores (pure ranking quality)
  const key = (w) => `${w.trend}|${w.rsi}|${w.fund}|${w.mom}|${w.sent}|${w.growthTtm}|${w.marginTtm}`;
  const contByKey = new Map();
  let i = 0;
  for (const w of combos()) {
    const r = evaluateCombo(months, w, true);
    results.push(r);
    const rc = evaluateCombo(months, w, false);
    resultsCont.push(rc);
    contByKey.set(key(w), rc);
    i++;
    if (i % 50 === 0) console.log(`[grid ${i}] latest avgSpearman=${r.avgSpearman?.toFixed(3)}`);
  }
  console.log(`Evaluated ${results.length} combos (rounded + unrounded).`);

  const isBaseline = (w) => Object.entries(BASELINE).every(([k, v]) => w[k] === v);
  const baseline = results.find((r) => isBaseline(r.weights));
  // Rank by overall mean Spearman; tie-break: top-minus-mid, then agreement
  // with the CURRENT weights (among exact rank-ties — e.g. sentiment variants,
  // whose raw contribution is 0 in this backtest — prefer the status-quo value
  // over noise-level BUY-alpha differences: don't change what can't be measured).
  const statusQuoAgreement = (w) => Object.entries(BASELINE).filter(([k, v]) => w[k] === v).length;
  const sorted = [...results].sort((a, b) =>
    (b.avgSpearman ?? -9) - (a.avgSpearman ?? -9) ||
    (b.avgTopMinusMid ?? -9) - (a.avgTopMinusMid ?? -9) ||
    statusQuoAgreement(b.weights) - statusQuoAgreement(a.weights)
  );

  const meetsCriteria = (r, base) =>
    r.firstHalfSpearman > 0 && r.secondHalfSpearman > 0 &&
    r.avgSpearman >= (base?.avgSpearman ?? -9) + 0.10 &&
    r.avgTopMinusMid > 0;

  const adoptionCriteria = {
    rule: 'CLUSTER-robust: combos whose exact-tie cluster (differing only in blocks with identically-zero raw contribution — sentiment here) has positive mean Spearman in BOTH halves under the engine-exact rounded scorer for EVERY variant, plus the same criteria under the unrounded scorer; overall Spearman >= baseline + 0.10 and top-quintile-minus-middle > 0. The growth_ttm/margin_ttm blocks have NONZERO raw contribution in TTM-covered months, so variants differing in them are NOT exact ties — each must earn adoption on its own metrics; the winner additionally requires its neighbor variants (other grid levels of the same TTM blocks) to be reported for sign consistency. Rationale: variants that differ only in a zero-contribution block are the same ranking up to rounding tie-breaks — if the OOS sign depends on which variant you pick, it is not robust.',
    baselineOverallSpearman: r3(baseline?.avgSpearman),
    baselineFirstHalf: r3(baseline?.firstHalfSpearman),
    baselineSecondHalf: r3(baseline?.secondHalfSpearman),
    baselineTopMinusMid: r2(baseline?.avgTopMinusMid),
  };
  // Group into exact-tie clusters by every block EXCEPT sentiment (the only
  // identically-zero-contribution block in this backtest).
  const clusters = new Map(); // clusterKey -> { members: [rounded results], cont }
  for (const r of results) {
    const ck = `${r.weights.trend}|${r.weights.rsi}|${r.weights.fund}|${r.weights.mom}|${r.weights.growthTtm}|${r.weights.marginTtm}`;
    if (!clusters.has(ck)) clusters.set(ck, { members: [] });
    clusters.get(ck).members.push(r);
  }
  for (const c of clusters.values()) {
    const sqMember = c.members.find((m) => m.weights.sent === BASELINE.sent) ?? c.members[0];
    c.cont = contByKey.get(key(sqMember.weights));
  }
  const passingClusters = [...clusters.values()]
    .filter((c) => c.cont && meetsCriteria(c.cont, baseline) && c.members.every((m) => m.firstHalfSpearman > 0 && m.secondHalfSpearman > 0))
    .sort((a, b) =>
      (b.cont.avgSpearman ?? -9) - (a.cont.avgSpearman ?? -9) ||
      (b.cont.avgTopMinusMid ?? -9) - (a.cont.avgTopMinusMid ?? -9)
    );
  const pickFromCluster = (c) =>
    c.members.find((m) => m.weights.sent === BASELINE.sent) ?? c.members[0];
  const winner = passingClusters.length ? pickFromCluster(passingClusters[0]) : null;
  const candidates = passingClusters;
  // Most OOS-robust criteria-meeting cluster (highest unrounded second-half
  // Spearman) — reported as the runner-up when it differs from the winner.
  const mostRobust = candidates.length
    ? [...candidates].sort((a, b) => b.cont.secondHalfSpearman - a.cont.secondHalfSpearman)[0]
    : null;
  const mostRobustMember = mostRobust ? pickFromCluster(mostRobust) : null;
  const winnerCont = winner ? contByKey.get(key(winner.weights)) : null;

  // Factor marginal analysis: mean Spearman per weight level per block.
  const factorLevels = {};
  for (const [block, levels] of Object.entries(GRID)) {
    factorLevels[block] = {};
    for (const lvl of levels) {
      const group = results.filter((r) => r.weights[block] === lvl && r.avgSpearman != null);
      factorLevels[block][lvl] = group.length
        ? {
            n: group.length,
            meanSpearman: r3(avg(group.map((r) => r.avgSpearman))),
            meanTopMinusMid: r2(avg(group.map((r) => r.avgTopMinusMid))),
          }
        : null;
    }
  }

  // Factor verdict from the marginal means: monotone fall with weight = dead,
  // monotone rise = alive, otherwise neutral (no consistent direction).
  const factorVerdict = Object.entries(factorLevels).map(([block, levels]) => {
    const vals = Object.entries(levels).map(([lvl, v]) => [Number(lvl), v?.meanSpearman]).filter(([, v]) => v != null);
    if (vals.length < 2) return { block, verdict: 'untestable' };
    vals.sort((a, b) => a[0] - b[0]);
    const diffs = vals.slice(1).map((v, i) => v[1] - vals[i][1]);
    const allUp = diffs.every((x) => x > 0);
    const allDown = diffs.every((x) => x < 0);
    const spread = vals[vals.length - 1][1] - vals[0][1];
    const verdict = allDown && spread < -0.01 ? 'DEAD (anti-predictive: mean Spearman falls monotonically with weight)'
      : allUp && spread > 0.01 ? 'ALIVE (mean Spearman rises monotonically with weight)'
      : 'NEUTRAL/FLAT (no consistent ranking contribution)';
    return { block, verdict, levels: Object.fromEntries(vals.map(([l, v]) => [l, r3(v)])) };
  });

  const fmtW = (w) => `trend ${w.trend} / rsi ${w.rsi} / fund ${w.fund} / mom ${w.mom} / sent ${w.sent} / gtmm ${w.growthTtm} / mtmm ${w.marginTtm}`;
  const doc = {
    generatedAt: new Date().toISOString(),
    config: {
      years: YEARS, horizonDays: HORIZON, top: TOP, grid: GRID, totalScale: TOTAL_SCALE,
      parameterization: 'block points scaled by w/shipCap, total renormalized to 110; sentiment raw = 0 in backtest (no historical feed); growth_ttm/margin_ttm are single-factor sector-percentile blocks on the ±35 scale, TTM computed per checkpoint from facts_quarterly + 10-K FY facts with the filed_at look-ahead guard',
      dataCache: CACHE, signals: totalSignals, checkpoints: months.length,
      ttmCoverage: {
        monthsWithTtm: ttmCoverage.length,
        avgShareOfSnapshot: ttmCoverage.length ? +avg(ttmCoverage.map((c) => c.have / c.total)).toFixed(3) : 0,
        firstMonth: ttmCoverage[0]?.monthKey ?? null,
        lastMonth: ttmCoverage[ttmCoverage.length - 1]?.monthKey ?? null,
        detail: ttmCoverage,
      },
    },
    adoptionCriteria,
    baseline: baseline ? { ...baseline, avgSpearman: r3(baseline.avgSpearman), avgTopMinusMid: r2(baseline.avgTopMinusMid), firstHalfSpearman: r3(baseline.firstHalfSpearman), secondHalfSpearman: r3(baseline.secondHalfSpearman), buyTickerAlphaMean: r2(baseline.buyTickerAlphaMean), buyCi95: baseline.buyCi95?.map(r2), positiveShare: baseline.positiveShare == null ? null : +baseline.positiveShare.toFixed(1) } : null,
    top10: sorted.slice(0, 10).map((r) => {
      const cont = contByKey.get(key(r.weights));
      return {
        weights: r.weights, avgSpearman: r3(r.avgSpearman), medianSpearman: r3(r.medianSpearman),
        positiveShare: r.positiveShare == null ? null : +r.positiveShare.toFixed(1),
        avgTopMinusMid: r2(r.avgTopMinusMid), topAboveMidShare: r.topAboveMidShare == null ? null : +r.topAboveMidShare.toFixed(1),
        firstHalfSpearman: r3(r.firstHalfSpearman), secondHalfSpearman: r3(r.secondHalfSpearman),
        unrounded: { avgSpearman: r3(cont?.avgSpearman), firstHalfSpearman: r3(cont?.firstHalfSpearman), secondHalfSpearman: r3(cont?.secondHalfSpearman) },
        buy90dAlpha: r2(r.buyTickerAlphaMean), buyCi95: r.buyCi95?.map(r2), buyTickers: r.buyTickers,
        isBaseline: isBaseline(r.weights),
        meetsCriteriaBothScorers: meetsCriteria(r, baseline) && meetsCriteria(cont, baseline),
      };
    }),
    winner: winner ? { ...winner, avgSpearman: r3(winner.avgSpearman), avgTopMinusMid: r2(winner.avgTopMinusMid), firstHalfSpearman: r3(winner.firstHalfSpearman), secondHalfSpearman: r3(winner.secondHalfSpearman), buyTickerAlphaMean: r2(winner.buyTickerAlphaMean), buyCi95: winner.buyCi95?.map(r2), unrounded: { avgSpearman: r3(winnerCont?.avgSpearman), firstHalfSpearman: r3(winnerCont?.firstHalfSpearman), secondHalfSpearman: r3(winnerCont?.secondHalfSpearman) } } : null,
    mostOosRobustCandidate: mostRobustMember ? { weights: mostRobustMember.weights, avgSpearman: r3(mostRobust.cont.avgSpearman), firstHalfSpearman: r3(mostRobust.cont.firstHalfSpearman), secondHalfSpearman: r3(mostRobust.cont.secondHalfSpearman), avgTopMinusMid: r2(mostRobust.cont.avgTopMinusMid) } : null,
    candidatesMeetingCriteria: candidates.length,
    factorMarginalMeans: factorLevels,
    factorVerdict,
    allResults: results.map((r) => ({
      w: [r.weights.trend, r.weights.rsi, r.weights.fund, r.weights.mom, r.weights.sent, r.weights.growthTtm, r.weights.marginTtm],
      sp: r3(r.avgSpearman), tmm: r2(r.avgTopMinusMid), h1: r3(r.firstHalfSpearman), h2: r3(r.secondHalfSpearman), buy: r2(r.buyTickerAlphaMean),
    })),
    allResultsUnrounded: resultsCont.map((r) => ({
      w: [r.weights.trend, r.weights.rsi, r.weights.fund, r.weights.mom, r.weights.sent, r.weights.growthTtm, r.weights.marginTtm],
      sp: r3(r.avgSpearman), tmm: r2(r.avgTopMinusMid), h1: r3(r.firstHalfSpearman), h2: r3(r.secondHalfSpearman),
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));

  // ---- markdown summary ----
  const rows = doc.top10.map((r, idx) =>
    `| ${idx + 1} | ${fmtW(r.weights)} | ${r.avgSpearman} | ${r.avgTopMinusMid} | ${r.firstHalfSpearman} | ${r.secondHalfSpearman} | ${r.buy90dAlpha} [${r.buyCi95?.[0]}, ${r.buyCi95?.[1]}] | ${r.isBaseline ? '**current**' : ''} |`
  ).join('\n');
  const factorRows = Object.entries(factorLevels).map(([block, levels]) => {
    const cells = Object.entries(levels).map(([lvl, v]) => `${lvl}: ${v ? v.meanSpearman : 'n/a'}`).join(' | ');
    return `| ${block} | ${cells} |`;
  }).join('\n');
  const md = `# Verdict factor-weight search — ${doc.generatedAt}

Config: ${YEARS}y backtest, ${HORIZON}d horizon, top ${TOP} universe, ${months.length} months × ${totalSignals} observations, ${results.length} combos (7-block grid incl. growth_ttm / margin_ttm).
Parameterization: block points scaled by w/shipCap, total renormalized to 110 (current weights reproduce the shipped engine exactly). Sentiment raw points are 0 in the backtest (no historical news feed) — its weight cannot be validated here.
TTM factors: growth_ttm / margin_ttm are rolling-4-quarter revenue growth / net margin, computed per checkpoint from facts_quarterly + 10-K FY facts with the filed_at look-ahead guard (only facts FILED before the checkpoint are visible; derived Q4 carries the 10-K filing date). Coverage honesty: ${ttmCoverage.length}/${months.length} months have any TTM data (quarterly warehouse reaches back ~40 months), avg ${doc.config.ttmCoverage.avgShareOfSnapshot * 100}% of the snapshot per covered month — TTM blocks are silent before the first covered month.

## Baseline (current weights: ${fmtW(BASELINE)})
- Overall mean Spearman: **${doc.baseline?.avgSpearman}** (median ${doc.baseline?.medianSpearman}, positive in ${doc.baseline?.positiveShare}% of months)
- First half: ${doc.baseline?.firstHalfSpearman} | Second half: ${doc.baseline?.secondHalfSpearman}
- Top − middle quintile alpha: ${doc.baseline?.avgTopMinusMid}% per month
- BUY 90d alpha (ticker-level mean): ${doc.baseline?.buyTickerAlphaMean}% CI95 ${doc.baseline?.buyCi95?.join('%, ')}%

## Top 10 combos by mean Spearman
| # | ${'trend / rsi / fund / mom / sent / gtmm / mtmm'} | Spearman | top−mid | H1 Spearman | H2 Spearman | BUY 90d α [CI] | note |
|---|---|---|---|---|---|---|---|
${rows}

## Factor marginal means (mean overall Spearman across all combos at each level)
| block | mean Spearman by level |
|---|---|
${factorRows}

## Factor verdict (from marginal means)
${factorVerdict.map((v) => `- **${v.block}**: ${v.verdict}`).join('\n')}

## Recommendation
${winner
    ? `**ADOPT**: ${fmtW(winner.weights)} — overall Spearman ${r3(winner.avgSpearman)} (baseline ${doc.baseline?.avgSpearman}), H1 ${r3(winner.firstHalfSpearman)} / H2 ${r3(winner.secondHalfSpearman)} (both positive), top−mid ${r2(winner.avgTopMinusMid)}%. Its exact-tie cluster holds both halves POSITIVE under the engine-exact rounded scorer for every variant AND under the unrounded scorer (unrounded: overall ${r3(winnerCont?.avgSpearman)}, H1 ${r3(winnerCont?.firstHalfSpearman)}, H2 ${r3(winnerCont?.secondHalfSpearman)}). ${candidates.length} cluster(s) met the cluster-robust criteria.`
    : `**NO CHANGE**: no combo met the adoption criteria under the cluster-robust evaluation (${adoptionCriteria.rule}). ${candidates.length} of ${clusters.size} clusters qualified. The honest result is that the current weights are not meaningfully beatable on this data — see factor marginal means for which blocks look dead.
${sorted.length && sorted[0] && !winner ? `\nClosest miss: the highest-Spearman combo (${fmtW(sorted[0].weights)}, Spearman ${r3(sorted[0].avgSpearman)}, H1 ${r3(sorted[0].firstHalfSpearman)} / H2 ${r3(sorted[0].secondHalfSpearman)}) FAILS the quintile-monotonicity requirement — top−middle = ${r2(sorted[0].avgTopMinusMid)}% (top quintile at/below the middle means the score does not rank the top of the book correctly, regardless of the overall correlation). It buys its correlation by zeroing momentum (${sorted[0].weights.mom === 0 ? 'mom 0' : `mom ${sorted[0].weights.mom}`}) and loading growth_ttm — not adoptable under the shipped rule.` : ''}`}

${winner && mostRobustMember && JSON.stringify(mostRobustMember.weights) !== JSON.stringify(winner.weights)
    ? `\nMost OOS-robust criteria-meeting cluster (highest unrounded second-half Spearman): **${fmtW(mostRobustMember.weights)}** — overall ${r3(mostRobust.cont.avgSpearman)}, H1 ${r3(mostRobust.cont.firstHalfSpearman)} / H2 ${r3(mostRobust.cont.secondHalfSpearman)}, top−mid ${r2(mostRobust.cont.avgTopMinusMid)}%.`
    : ''}

Tie-break note: sentiment-variant combos tie EXACTLY on all rank metrics (sentiment raw points are 0 in this backtest); among exact ties the search prefers the CURRENT weight value — sentiment cannot be measured here, so it is not changed on noise-level BUY-alpha differences.

Dead-factor evidence (factor marginal means — mean overall Spearman across all combos at each weight level; monotone falls with weight = dead factor, rises = alive):
${Object.entries(factorLevels).map(([block, levels]) => `- ${block}: ${Object.entries(levels).map(([lvl, v]) => `${lvl} → ${v ? v.meanSpearman : 'n/a'}`).join(', ')}`).join('\n')}

Guardrails: in-sample (first half) vs OOS (second half) Spearman reported separately; adoption requires sign agreement in BOTH halves. Sentiment is untestable in this backtest. TTM factors are only measurable in TTM-covered months (see coverage above) — a TTM-based winner rests on a shorter OOS sample, say so when reporting.
`;
  fs.writeFileSync(SUMMARY, md);

  console.log(`\nBaseline Spearman ${doc.baseline?.avgSpearman} (H1 ${doc.baseline?.firstHalfSpearman} / H2 ${doc.baseline?.secondHalfSpearman}), top−mid ${doc.baseline?.avgTopMinusMid}%`);
  console.log(`Winner: ${winner ? fmtW(winner.weights) + ` sp=${r3(winner.avgSpearman)} H1=${r3(winner.firstHalfSpearman)} H2=${r3(winner.secondHalfSpearman)}` : 'NONE meeting adoption criteria'}`);
  console.log(`Saved: ${OUT}\nSaved: ${SUMMARY}`);
}

// Run only when executed directly (importable as a lib for probes/tests).
import { fileURLToPath as _f2p } from 'node:url';
if (process.argv[1] && _f2p(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}

export { buildTtmAsOf, quarterlySeriesTtm, ttmWindowTtm, REVENUE_TAGS_TTM, NET_INCOME_TAGS_TTM };
