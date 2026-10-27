#!/usr/bin/env node
/**
 * Entry-timing / universe-selection slice lab — final roadmap item.
 *
 * Question: the ticker-level 90d BUY alpha vs SPY is significantly NEGATIVE
 * (−1.76 [−2.53, −1.0]) while the 90d ranking is monotone. Does the drag
 * concentrate in specific slices, or is it universal?
 *
 * Slices tested (all on the v3 baseline engine, same pipeline as
 * scripts/reversal-lab.mjs / weight-search.mjs — same universe, same
 * look-ahead-free fundamentals, same sector percentiles, same ticker-level
 * bootstrap 1000 draws seed 42):
 *   1. Sector (GICS sector_label from the warehouse; "Unknown" = null)
 *   2. Market-cap band — static marketCap from Yahoo quote (DISCLOSED
 *      look-ahead: classification only, but caps are as-of today, not as-of
 *      checkpoint; cross-checked against dollar-volume terciles)
 *   3. Dollar-volume tercile (price × volume, 10d median, per-checkpoint
 *      cross-sectional terciles — fully look-ahead-free size/liquidity proxy)
 *   4. Price band at checkpoint (<$50 / 50–100 / 100–400 / ≥$400)
 *   5. Per month
 *   6. Regime (candles only): SPY 20d realized-vol tercile, breadth
 *      (share of checkpoint universe above own SMA200) tercile, SPY vs SMA200
 *
 * Data: tmp/bt-data-cache-600.json (cached candles, no re-fetch).
 * Output: data/entry-timing-slices.json + console summary.
 * Nothing committed; no quantEngine/weight-search changes.
 *
 * Usage: node scripts/entry-timing-lab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const CACHE = path.join(ROOT, 'tmp', 'bt-data-cache-600.json');
const OUT = path.join(ROOT, 'data', 'entry-timing-slices.json');
const DAY_MS = 24 * 3600 * 1000;
const HORIZONS = [5, 21, 90];

// ---- v3 adopted weights (mirrors quantEngine.mjs — keep in lockstep) ----
const FACTOR_WEIGHTS = { trend: 0, rsi: 5, fund: 0, mom: 20, sent: 25 };
const FACTOR_CAPS = { trend: 25, rsi: 15, fund: 35, mom: 10, sent: 25 };
const TOTAL_SCALE = 110;
const MOM_BLOCK_MAX = 10;

// ---- quant-core mirrors (verbatim from scripts/reversal-lab.mjs) ----
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
  const momRaw = m121 !== undefined ? m121 * 50 : null;
  let bearishVotes = 0;
  if (trend === 'down') bearishVotes++;
  if (fundamentals && ((fundamentals.revenueGrowthYoY !== undefined && fundamentals.revenueGrowthYoY < -5) || (fundamentals.netMargin !== undefined && fundamentals.netMargin < 0))) bearishVotes++;
  if (rv !== undefined && rv > 70) bearishVotes++;
  return { trendPts, rsiPts, fundPts, momRaw, trend, rv, bearishVotes };
}

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
    t = (t ^ (t >>> 14)) >>> 0;
    return t / 4294967296;
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

// ======================= checkpoint factor table =======================
const YEARS = 3;
function buildCheckpoints(data) {
  const { spy, universe } = data;
  const tickerData = new Map();
  for (const [ticker, d] of Object.entries(universe)) tickerData.set(ticker, d);

  const monthMs = 30.44 * 24 * 3600 * 1000;
  const checkpointCount = Math.floor((YEARS * 365 - Math.max(...HORIZONS)) / 30.44);
  const latestT = Math.max(...[...tickerData.values()].map((d) => d.candles[d.candles.length - 1].t));

  const months = [];
  let totalSignals = 0;
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
      if (idx < 0 || idx < 253) continue;
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
      // slice covariates (look-ahead-free, from the candle slice only)
      const s50 = sma(s.closes, 50), s200 = sma(s.closes, 200);
      const last10 = s.slice.slice(-10);
      const dvol10 = last10.map((c) => c.close * (c.volume || 0)).sort((a, b) => a - b)[Math.floor(last10.length / 2)] ?? undefined;
      recs.push({
        ticker: s.ticker,
        raw,
        fwds,
        price: s.c0.close,
        dvol10,
        aboveS200: s200 !== undefined && s.c0.close > s200,
        sector: s.sector == null ? 'Unknown' : s.sector,
      });
      totalSignals++;
    }
    if (recs.length) months.push({ monthKey, recs });
  }
  months.sort((a, b) => (a.monthKey < b.monthKey ? -1 : 1));
  return { months, totalSignals };
}

// ============================ scoring (baseline v3) ============================
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function scoreRaw(raw) {
  const wSum = FACTOR_WEIGHTS.trend + FACTOR_WEIGHTS.rsi + FACTOR_WEIGHTS.fund + FACTOR_WEIGHTS.mom + FACTOR_WEIGHTS.sent;
  const scale = TOTAL_SCALE / wSum;
  let s = 0;
  if (FACTOR_WEIGHTS.rsi) s += (FACTOR_WEIGHTS.rsi / FACTOR_CAPS.rsi) * raw.rsiPts;
  if (FACTOR_WEIGHTS.mom && raw.momRaw != null) s += (FACTOR_WEIGHTS.mom / FACTOR_CAPS.mom) * clamp(raw.momRaw, -MOM_BLOCK_MAX, MOM_BLOCK_MAX);
  return s * scale;
}

function actionFor(score, raw) {
  let action = 'HOLD';
  if (score >= 35) action = 'BUY';
  else if (score < -15 && raw.bearishVotes >= 2) action = 'SELL';
  return action;
}

// ============================ slice machinery ============================
const CAP_BANDS = [
  { id: 'cap<$10B', test: (c) => c != null && c < 10e9 },
  { id: 'cap$10-50B', test: (c) => c != null && c >= 10e9 && c < 50e9 },
  { id: 'cap$50-200B', test: (c) => c != null && c >= 50e9 && c < 200e9 },
  { id: 'cap>=$200B', test: (c) => c != null && c >= 200e9 },
];
const PRICE_BANDS = [
  { id: 'px<$50', test: (p) => p < 50 },
  { id: 'px$50-100', test: (p) => p >= 50 && p < 100 },
  { id: 'px$100-400', test: (p) => p >= 100 && p < 400 },
  { id: 'px>=$400', test: (p) => p >= 400 },
];

function sliceStats(obs, label) {
  // ticker-level alpha means + bootstrap CI, overall and per half (month halves)
  const out = { label, nObs: obs.length, nTickers: 0, nMonths: 0 };
  if (!obs.length) return out;
  out.meanAlpha90 = avg(obs.map((o) => o.alpha90));
  out.meanFwd90 = avg(obs.map((o) => o.fwd90));
  out.meanAlpha21 = avg(obs.map((o) => o.alpha21));
  const byTicker = new Map();
  for (const o of obs) {
    if (!byTicker.has(o.ticker)) byTicker.set(o.ticker, []);
    byTicker.get(o.ticker).push(o.alpha90);
  }
  const alphas = [...byTicker.values()].map((a) => avg(a));
  out.nTickers = alphas.length;
  out.nMonths = new Set(obs.map((o) => o.monthKey)).size;
  const ci = bootstrapCi(alphas);
  out.alpha90 = { mean: avg(alphas), ci95: ci ? [ci.lo, ci.hi] : null };
  // halves: ticker-level within each half
  const halves = {};
  for (const [hk, test] of [['first', (o) => o.half === 0], ['second', (o) => o.half === 1]]) {
    const sub = obs.filter(test);
    const bt = new Map();
    for (const o of sub) {
      if (!bt.has(o.ticker)) bt.set(o.ticker, []);
      bt.get(o.ticker).push(o.alpha90);
    }
    const av = [...bt.values()].map((a) => avg(a));
    const c = bootstrapCi(av);
    halves[hk] = { nObs: sub.length, nTickers: av.length, mean: av.length ? avg(av) : null, ci95: c ? [c.lo, c.hi] : null };
  }
  out.halves = halves;
  out.robustPositive = out.alpha90.ci95 != null
    && out.alpha90.ci95[0] > 0
    && halves.first.mean > 0 && halves.second.mean > 0;
  return out;
}

// ================================ main ================================
async function main() {
  console.log('Loading cached candles...');
  const data = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log(`Cache: ${Object.keys(data.universe).length} tickers, fetched ${data.fetchedAt}`);

  // static market caps from Yahoo (classification only — disclosed look-ahead), cached
  const capCachePath0 = path.join(ROOT, 'tmp', 'cap-cache-600.json');
  const capByTicker = {};
  if (fs.existsSync(capCachePath0)) {
    try {
      const cc = JSON.parse(fs.readFileSync(capCachePath0, 'utf8'));
      Object.assign(capByTicker, cc.caps);
      console.log(`Market caps from cache: ${Object.keys(capByTicker).length} (fetched ${cc.fetchedAt})`);
    } catch { /* refetch below */ }
  }
  if (!Object.keys(capByTicker).length) {
    try {
      const { default: YahooFinance } = await import('yahoo-finance2');
      const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
      const tickers = Object.keys(data.universe);
      for (let i = 0; i < tickers.length; i += 100) {
        const batch = tickers.slice(i, i + 100);
        const quotes = await yf.quote(batch);
        for (const q of quotes) if (q && q.symbol && q.marketCap != null) capByTicker[q.symbol] = q.marketCap;
        await new Promise((r) => setTimeout(r, 300));
      }
      console.log(`Market caps fetched: ${Object.keys(capByTicker).length}/${tickers.length}`);
    } catch (e) {
      console.warn('Market-cap fetch failed — cap bands will be sparse:', String(e).slice(0, 200));
    }
  }

  console.log('Building checkpoint table...');
  const { months, totalSignals } = buildCheckpoints(data);
  console.log(`Checkpoints: ${months.length} months, ${totalSignals} observations`);

  // ---- score + build observation table ----
  const halfCut = Math.floor(months.length / 2);
  const obs = []; // BUY observations only (plus SELL/HOLD kept for reference counts)
  const perMonth = [];
  const dvolByMonth = [];
  for (let mi = 0; mi < months.length; mi++) {
    const { monthKey, recs } = months[mi];
    const scored = recs.map((r) => {
      const score = scoreRaw(r.raw);
      const action = actionFor(score, r.raw);
      return { ...r, score, action };
    });
    scored.sort((a, b) => a.score - b.score || (a.ticker < b.ticker ? -1 : 1));
    // rank metrics at 90d for context
    const qAlpha = [[], [], [], [], []];
    scored.forEach((rec, pos) => {
      qAlpha[quintileOf(pos, scored.length) - 1].push(rec.fwds[90].fwd - rec.fwds[90].spyFwd);
    });
    const meanAlpha = qAlpha.map((a) => avg(a));
    const sp = spearman([1, 2, 3, 4, 5], meanAlpha);
    // dollar-volume terciles within the checkpoint (look-ahead-free size proxy)
    const withDv = scored.filter((r) => Number.isFinite(r.dvol10)).map((r) => r.dvol10).sort((a, b) => a - b);
    const dvT = withDv.length >= 15
      ? [withDv[Math.floor(withDv.length / 3)], withDv[Math.floor((2 * withDv.length) / 3)]]
      : null;
    // breadth proxy: share of checkpoint universe above own SMA200
    const breadth = avg(scored.map((r) => (r.aboveS200 ? 1 : 0)));
    // SPY regime: computed below from spy closes by month (candles only)
    perMonth.push({ monthKey, n: scored.length, spearman: sp == null ? null : r3(sp), topMinusMid: r2(meanAlpha[4] - meanAlpha[2]), breadth: r3(breadth) });
    dvolByMonth.push(dvT);
    for (const r of scored) {
      if (r.action !== 'BUY') continue;
      const dvTercile = dvT ? (r.dvol10 <= dvT[0] ? 'low' : r.dvol10 <= dvT[1] ? 'mid' : 'high') : null;
      obs.push({
        monthKey, half: mi < halfCut ? 0 : 1, ticker: r.ticker, sector: r.sector,
        price: r.price, cap: capByTicker[r.ticker] ?? null, dvolTercile: dvTercile,
        aboveS200: r.aboveS200,
        fwd5: r.fwds[5].fwd, fwd21: r.fwds[21].fwd, fwd90: r.fwds[90].fwd,
        alpha21: r.fwds[21].fwd - r.fwds[21].spyFwd, alpha90: r.fwds[90].fwd - r.fwds[90].spyFwd,
      });
    }
  }
  console.log(`BUY observations: ${obs.length}`);

  // SPY regime per month (candles only): 20d realized vol + above/below month mean
  const spyByMonth = {};
  for (const c of data.spy) {
    const mk = new Date(c.t).toISOString().slice(0, 7);
    if (!spyByMonth[mk]) spyByMonth[mk] = [];
    spyByMonth[mk].push(c.c);
  }
  const spyVolByMonth = {};
  for (const [mk, closes] of Object.entries(spyByMonth)) {
    if (closes.length < 21) continue;
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const m = avg(rets);
    const vol = Math.sqrt(avg(rets.map((r) => (r - m) ** 2)) * 252) * 100;
    spyVolByMonth[mk] = { vol, above: closes[closes.length - 1] > avg(closes) };
  }
  const vols = Object.entries(spyVolByMonth).map(([mk, v]) => ({ mk, vol: v.vol })).sort((a, b) => a.vol - b.vol);
  const volT = [vols[Math.floor(vols.length / 3)]?.vol, vols[Math.floor((2 * vols.length) / 3)]?.vol];
  const breadths = perMonth.map((m) => m.breadth).sort((a, b) => a - b);
  const brT = [breadths[Math.floor(breadths.length / 3)], breadths[Math.floor((2 * breadths.length) / 3)]];
  for (const m of perMonth) {
    const sv = spyVolByMonth[m.monthKey];
    m.spyVol = sv ? r2(sv.vol) : null;
    m.spyTrend = sv ? (sv.above ? 'above' : 'below') : null;
    m.regimeVol = sv ? (sv.vol <= volT[0] ? 'low' : sv.vol <= volT[1] ? 'mid' : 'high') : null;
    m.regimeBreadth = m.breadth == null ? null : (m.breadth <= brT[0] ? 'low' : m.breadth <= brT[1] ? 'mid' : 'high');
    m.spyVolT = volT.map(r2), m.breadthT = brT.map(r3);
  }
  const regimeByMonth = Object.fromEntries(perMonth.map((m) => [m.monthKey, m]));
  for (const o of obs) {
    const rm = regimeByMonth[o.monthKey];
    o.regimeVol = rm?.regimeVol ?? null;
    o.regimeBreadth = rm?.regimeBreadth ?? null;
    o.spyTrend = rm?.spyTrend ?? null;
  }

  // ---- build slice tables ----
  const all = sliceStats(obs, 'ALL BUY');
  const tables = { all };

  const bySector = {};
  for (const sec of [...new Set(obs.map((o) => o.sector))].sort()) {
    bySector[sec] = sliceStats(obs.filter((o) => o.sector === sec), sec);
  }
  tables.sector = bySector;

  const byCap = {};
  for (const b of CAP_BANDS) byCap[b.id] = sliceStats(obs.filter((o) => b.test(o.cap)), b.id);
  byCap['cap=unknown'] = sliceStats(obs.filter((o) => o.cap == null), 'cap=unknown');
  tables.capBand = byCap;

  const byDv = {};
  for (const t of ['low', 'mid', 'high']) byDv[t] = sliceStats(obs.filter((o) => o.dvolTercile === t), `dvolTercile=${t}`);
  tables.dvolTercile = byDv;

  const byPx = {};
  for (const b of PRICE_BANDS) byPx[b.id] = sliceStats(obs.filter((o) => b.test(o.price)), b.id);
  byPx['px<$400'] = sliceStats(obs.filter((o) => o.price < 400), 'px<$400');
  byPx['px>=$400'] = sliceStats(obs.filter((o) => o.price >= 400), 'px>=$400');
  tables.priceBand = byPx;

  const byRegime = {};
  for (const t of ['low', 'mid', 'high']) {
    byRegime[`spyVol=${t}`] = sliceStats(obs.filter((o) => o.regimeVol === t), `spyVol=${t}`);
    byRegime[`breadth=${t}`] = sliceStats(obs.filter((o) => o.regimeBreadth === t), `breadth=${t}`);
  }
  byRegime['spyTrend=above'] = sliceStats(obs.filter((o) => o.spyTrend === 'above'), 'spyTrend=above');
  byRegime['spyTrend=below'] = sliceStats(obs.filter((o) => o.spyTrend === 'below'), 'spyTrend=below');
  tables.regime = byRegime;

  // per-month BUY table
  const perMonthBuy = perMonth.map((m) => ({ monthKey: m.monthKey }));
  for (const row of perMonthBuy) {
    const sub = obs.filter((o) => o.monthKey === row.monthKey);
    row.n = sub.length;
    row.alpha21 = r2(avg(sub.map((o) => o.alpha21)));
    row.alpha90 = r2(avg(sub.map((o) => o.alpha90)));
    row.fwd90 = r2(avg(sub.map((o) => o.fwd90)));
    row.spyVol = regimeByMonth[row.monthKey]?.spyVol ?? null;
    row.breadth = regimeByMonth[row.monthKey]?.breadth ?? null;
    row.spearman = regimeByMonth[row.monthKey]?.spearman ?? null;
    row.regimeVol = regimeByMonth[row.monthKey]?.regimeVol ?? null;
    row.regimeBreadth = regimeByMonth[row.monthKey]?.regimeBreadth ?? null;
  }

  // ---- candidate gates: any robust-positive slice → quantify a gate ----
  const robust = [];
  for (const [group, entries] of Object.entries(tables)) {
    if (group === 'all') continue;
    for (const [id, s] of Object.entries(entries)) {
      if (s.robustPositive && id !== 'cap=unknown') robust.push({ group, id, ...s });
    }
  }
  const gates = robust.map((r) => {
    const test = (o) => {
      if (r.group === 'sector') return o.sector === r.id;
      if (r.group === 'capBand') { const b = CAP_BANDS.find((x) => x.id === r.id); return b ? b.test(o.cap) : false; }
      if (r.group === 'dvolTercile') return o.dvolTercile === r.id.split('=')[1];
      if (r.group === 'priceBand') return r.id === 'px<$400' ? o.price < 400 : r.id === 'px>=$400' ? o.price >= 400 : (() => { const b = PRICE_BANDS.find((x) => x.id === r.id); return b ? b.test(o.price) : false; })();
      if (r.group === 'regime') {
        const [k, v] = r.id.split('=');
        return k === 'spyVol' ? o.regimeVol === v : k === 'breadth' ? o.regimeBreadth === v : o.spyTrend === v;
      }
      return false;
    };
    const inS = sliceStats(obs.filter(test), `${r.id} (gate IN)`);
    const outS = sliceStats(obs.filter((o) => !test(o)), `${r.id} (gate OUT)`);
    return { ...r, gateIn: inS, gateOut: outS };
  });

  // ---- focus analysis: concentration + gate quantification for candidate slices ----
  // (a) cap cache so reruns don't re-fetch
  const capCachePath = path.join(ROOT, 'tmp', 'cap-cache-600.json');
  if (Object.keys(capByTicker).length) fs.writeFileSync(capCachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), caps: capByTicker }));

  // (b) per-month alpha series for the candidate slices (concentration check)
  const focusTests = {
    'cap>=$200B': (o) => o.cap != null && o.cap >= 200e9,
    'cap>=$50B': (o) => o.cap != null && o.cap >= 50e9,
    'px$50-100': (o) => o.price >= 50 && o.price < 100,
  };
  const focus = {};
  for (const [id, test] of Object.entries(focusTests)) {
    const sub = obs.filter(test);
    const perM = {};
    for (const o of sub) {
      if (!perM[o.monthKey]) perM[o.monthKey] = [];
      perM[o.monthKey].push(o.alpha90);
    }
    const monthsArr = Object.entries(perM).map(([mk, a]) => ({ monthKey: mk, n: a.length, alpha90: r2(avg(a)) })).sort((x, y) => (x.monthKey < y.monthKey ? -1 : 1));
    const posMonths = monthsArr.filter((m) => m.alpha90 > 0).length;
    // top contributors (share of total alpha from best 2 months)
    const monthMeans = monthsArr.map((m) => m.alpha90 * m.n);
    const total = monthMeans.reduce((a, b) => a + b, 0);
    const sortedAbs = [...monthMeans].sort((a, b) => b - a);
    const top2Share = total > 0 ? (sortedAbs[0] + sortedAbs[1]) / total : null;
    // within-slice ranking quality: per-month Spearman of score vs alpha, restricted to slice
    const monthsRestricted = [];
    for (let mi = 0; mi < months.length; mi++) {
      const { monthKey, recs } = months[mi];
      const scored = recs.map((r) => ({ ticker: r.ticker, score: scoreRaw(r.raw), alpha: r.fwds[90].fwd - r.fwds[90].spyFwd }))
        .filter((r) => { const o = obs.find((x) => x.monthKey === monthKey && x.ticker === r.ticker); return o ? test(o) : false; });
      if (scored.length < RANK_MIN_UNIVERSE) continue;
      scored.sort((a, b) => a.score - b.score || (a.ticker < b.ticker ? -1 : 1));
      const qa = [[], [], [], [], []];
      scored.forEach((rec, pos) => qa[quintileOf(pos, scored.length) - 1].push(rec.alpha));
      const ma = qa.map(avg);
      monthsRestricted.push({ monthKey, n: scored.length, spearman: r3(spearman([1, 2, 3, 4, 5], ma)), topMinusMid: r2(ma[4] - ma[2]) });
    }
    const spVals = monthsRestricted.map((m) => m.spearman).filter((v) => v != null);
    focus[id] = {
      months: monthsArr,
      positiveMonthShare: monthsArr.length ? r2((100 * posMonths) / monthsArr.length) : null,
      top2MonthShareOfAlpha: top2Share == null ? null : r3(top2Share),
      withinSliceRanking: {
        monthsTested: monthsRestricted.length,
        avgSpearman: spVals.length ? r3(avg(spVals)) : null,
        avgTopMinusMid: monthsRestricted.length ? r2(avg(monthsRestricted.map((m) => m.topMinusMid))) : null,
        positiveSpearmanShare: spVals.length ? r2((100 * spVals.filter((v) => v > 0).length) / spVals.length) : null,
        perMonth: monthsRestricted,
      },
    };
  }

  // (c) cross-tab: cap>=$200B × sector
  const megaCross = {};
  for (const sec of [...new Set(obs.filter((o) => o.cap != null && o.cap >= 200e9).map((o) => o.sector))].sort()) {
    megaCross[sec] = sliceStats(obs.filter((o) => o.cap != null && o.cap >= 200e9 && o.sector === sec), `mega × ${sec}`);
  }

  // (d) full gate table: before/after for every candidate gate (coverage + all-horizon alphas)
  const gateTable = {};
  for (const [id, test] of Object.entries(focusTests)) {
    const keep = obs.filter(test);
    const drop = obs.filter((o) => !test(o));
    gateTable[id] = {
      keptObs: keep.length, keptSharePct: r2((100 * keep.length) / obs.length),
      keptTickers: new Set(keep.map((o) => o.ticker)).size,
      kept: sliceStats(keep, `${id} kept`),
      dropped: sliceStats(drop, `${id} dropped`),
    };
  }

  const doc = {
    generatedAt: new Date().toISOString(),
    config: { years: YEARS, top: 600, dataCache: CACHE, signals: totalSignals, checkpoints: months.length, buyObs: obs.length, bootstrap: { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED }, capSource: 'Yahoo quote (static, as-of fetch date — classification only, disclosed look-ahead)', dvolProxy: '10d median dollar volume, per-checkpoint terciles (look-ahead-free)' },
    tables,
    perMonthBuy,
    robustPositiveSlices: robust.map((r) => ({ group: r.group, id: r.id, alpha90: r.alpha90, halves: r.halves, nObs: r.nObs })),
    gates,
    focus,
    megaCross,
    gateTable,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  console.log(`Saved: ${OUT}`);

  // ---- console summary ----
  const fmt = (s) => `${r2(s.alpha90?.mean)} [${s.alpha90?.ci95 ? s.alpha90.ci95.map(r2).join(',') : 'n/a'}] | H1 ${r2(s.halves?.first?.mean)} [${s.halves?.first?.ci95 ? s.halves.first.ci95.map(r2).join(',') : 'n/a'}] | H2 ${r2(s.halves?.second?.mean)} [${s.halves?.second?.ci95 ? s.halves.second.ci95.map(r2).join(',') : 'n/a'}] | n=${s.nObs}`;
  console.log(`\nALL BUY 90d: ${fmt(all)}`);
  for (const [group, entries] of Object.entries(tables)) {
    if (group === 'all') continue;
    console.log(`\n== ${group} ==`);
    for (const [id, s] of Object.entries(entries)) {
      if (s.nObs < 20) { console.log(`  ${id}: n=${s.nObs} (skip, too few)`); continue; }
      console.log(`  ${id}: ${fmt(s)}${s.robustPositive ? '  <-- ROBUST POSITIVE' : ''}`);
    }
  }
  console.log(`\nRobust-positive slices: ${robust.length ? robust.map((r) => `${r.group}:${r.id}`).join(', ') : 'NONE'}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
