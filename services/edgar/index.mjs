#!/usr/bin/env node
/**
 * svc-edgar (port 8002) — screener, search, company fundamentals per ADR-001.
 * Ported from src/services/edgarService.ts: @duckdb/node-api READ_ONLY against
 * data/warehouse.duckdb, prices merged from data/latest-prices.json (written by
 * scripts/refresh-prices.mjs) for marketCap/PE — never touches the warehouse
 * writer's lock beyond a read-only open.
 *
 * Handles warehouse-missing / warehouse-locked gracefully (isWarehouseReady
 * pattern): endpoints return empty results with a `warehouseReady: false` flag
 * instead of 500s.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startService, loadEnvLocal, REPO_ROOT } from '../shared/lib.mjs';

loadEnvLocal();

const WAREHOUSE_PATH = path.join(REPO_ROOT, 'data', 'warehouse.duckdb');
const PRICES_JSON_PATH = path.join(REPO_ROOT, 'data', 'latest-prices.json');

const REVENUE_TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
  'SalesRevenueGoodsNet',
  'SalesRevenueServicesNet',
];

// ---- Warehouse connection (lazy, read-only; null when unavailable) --------
let connectionPromise = null;

async function getConnection() {
  if (!fs.existsSync(WAREHOUSE_PATH)) return null;
  if (!connectionPromise) {
    connectionPromise = import('@duckdb/node-api')
      .then(({ DuckDBInstance }) => DuckDBInstance.create(WAREHOUSE_PATH, { access_mode: 'READ_ONLY' }))
      .then((instance) => instance.connect());
    connectionPromise.catch(() => { connectionPromise = null; });
  }
  try {
    return await connectionPromise;
  } catch {
    return null;
  }
}

/** True when the warehouse exists, is openable and has ingested companies. */
async function isWarehouseReady() {
  const conn = await getConnection();
  if (!conn) return false;
  try {
    const r = await conn.runAndReadAll('SELECT COUNT(*) AS n FROM metrics_latest');
    const rows = r.getRowObjectsJson();
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false; // e.g. file locked by a concurrent ingest
  }
}

// ---- Price snapshot (data/latest-prices.json — cheap, no DB lock) --------
let priceMapCache = { map: null, loadedAt: 0 };

function loadPriceMap() {
  // Re-read at most every 60s so a refreshed snapshot is picked up cheaply.
  if (priceMapCache.map && Date.now() - priceMapCache.loadedAt < 60_000) return priceMapCache.map;
  try {
    const raw = JSON.parse(fs.readFileSync(PRICES_JSON_PATH, 'utf8'));
    const map = {};
    for (const [ticker, q] of Object.entries(raw)) {
      const price = Number(q?.price);
      if (Number.isFinite(price) && price > 0) {
        map[ticker.toUpperCase()] = { price, peRatio: Number.isFinite(Number(q?.peRatio)) ? Number(q.peRatio) : null, marketCap: Number.isFinite(Number(q?.marketCap)) ? Number(q.marketCap) : null };
      }
    }
    priceMapCache = { map, loadedAt: Date.now() };
    return map;
  } catch {
    priceMapCache = { map: {}, loadedAt: Date.now() };
    return priceMapCache.map;
  }
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- Screener (port of edgarService.getScreenerResults) -------------------
// Shared revenue-growth CTE (latest vs prior fiscal-year revenue per CIK) —
// used by BOTH the screener and /sector-stats so the growth basis never drifts.
function revenueCteSql() {
  return `
    WITH rev AS (
      SELECT cik, "end" AS period_end, MAX(val) AS val
      FROM facts
      WHERE tag IN (${REVENUE_TAGS.map(() => '?').join(', ')})
      GROUP BY cik, "end"
    ),
    ranked AS (
      SELECT
        cik, period_end, val,
        ROW_NUMBER() OVER (PARTITION BY cik ORDER BY period_end DESC) AS rn,
        DATEDIFF('day',
          LAG(period_end) OVER (PARTITION BY cik ORDER BY period_end DESC),
          period_end) AS gap
      FROM rev
    ),
    prior AS (
      SELECT
        cik,
        MAX(CASE WHEN rn = 1 THEN val END) AS rev_latest,
        MAX(CASE WHEN rn = 2 AND ABS(gap) BETWEEN 300 AND 400 THEN val END) AS rev_prior
      FROM ranked
      GROUP BY cik
    )
  `;
}

async function getScreenerResults(filters) {
  const conn = await getConnection();
  if (!conn) return { warehouseReady: false, results: [] };
  const ready = await isWarehouseReady();
  if (!ready) return { warehouseReady: false, results: [] };

  const limit = Math.max(1, Math.min(filters.limit ?? 10, 1000)); // default 10 per screen — user preference (2026-10-27)
  const search = filters.searchQuery?.trim();

  const sql = `${revenueCteSql()}
    SELECT
      c.cik, c.ticker, c.name, c.sector_label,
      m.revenue, m.net_income, m.eps_diluted, m.total_assets, m.total_debt,
      m.stockholders_equity, m.gross_profit, m.operating_income,
      m.fiscal_year, m.fiscal_period, m.shares_outstanding, m.dividends_per_share,
      p.rev_prior
    FROM companies c
    JOIN metrics_latest m ON m.cik = c.cik
    LEFT JOIN prior p ON p.cik = c.cik
    WHERE 1 = 1
    ${filters.sector && filters.sector !== 'ALL' ? 'AND LOWER(c.sector_label) = LOWER(?)' : ''}
    ${search ? 'AND (c.name ILIKE ? OR c.ticker ILIKE ?)' : ''}
  `;

  const params = [...REVENUE_TAGS];
  if (filters.sector && filters.sector !== 'ALL') params.push(filters.sector);
  if (search) params.push(`%${search}%`, `%${search}%`);

  let rows;
  try {
    const reader = await conn.runAndReadAll(sql, params);
    rows = reader.getRowObjectsJson();
  } catch (err) {
    console.error('[svc-edgar] query failed:', err);
    return { warehouseReady: true, results: [] };
  }

  const priceMap = loadPriceMap();
  const results = [];
  for (const row of rows) {
    const ticker = row.ticker;
    const priceEntry = priceMap[ticker];
    const price = priceEntry?.price;
    const hasPrice = typeof price === 'number' && Number.isFinite(price) && price > 0;

    const revenue = num(row.revenue);
    const netIncome = num(row.net_income);
    const eps = num(row.eps_diluted);
    const equity = num(row.stockholders_equity);
    const shares = num(row.shares_outstanding);
    const dps = num(row.dividends_per_share);
    const revPrior = num(row.rev_prior);

    // marketCap/PE come from the price snapshot; fall back to Yahoo snapshot
    // marketCap when shares*price isn't computable.
    const marketCap = hasPrice && shares && shares > 0 ? shares * price : (priceEntry?.marketCap ?? null);
    const peRatio = hasPrice && eps && eps > 0 ? price / eps : (priceEntry?.peRatio ?? null);
    const netMargin = revenue && netIncome !== null ? (netIncome / revenue) * 100 : null;
    const roe = equity && equity > 0 && netIncome !== null ? (netIncome / equity) * 100 : null;
    const revenueGrowthYoY = revenue && revPrior && revPrior > 0 ? ((revenue - revPrior) / revPrior) * 100 : null;
    const dividendYield = hasPrice && dps && dps > 0 ? (dps / price) * 100 : null;

    // ---- filters (null-safe: exclude unknowns when a threshold is set) ----
    if (filters.minMarketCap !== undefined && (marketCap === null || marketCap < filters.minMarketCap)) continue;
    if (filters.maxMarketCap !== undefined && (marketCap === null || marketCap > filters.maxMarketCap)) continue;
    if (filters.maxPe !== undefined && (peRatio === null || peRatio > filters.maxPe)) continue;
    if (filters.minPE !== undefined && (peRatio === null || peRatio < filters.minPE)) continue;
    if (filters.minRevenueGrowth !== undefined && (revenueGrowthYoY === null || revenueGrowthYoY < filters.minRevenueGrowth)) continue;
    if (filters.minNetMargin !== undefined && (netMargin === null || netMargin < filters.minNetMargin)) continue;
    if (filters.minRoe !== undefined && (roe === null || roe < filters.minRoe)) continue;
    if (filters.minDividendYield !== undefined && (dividendYield === null || dividendYield < filters.minDividendYield)) continue;
    if (filters.maxDividendYield !== undefined && (dividendYield === null || dividendYield > filters.maxDividendYield)) continue;

    results.push({
      symbol: ticker,
      name: row.name,
      sector: row.sector_label ?? 'Unknown',
      price: hasPrice ? price : 0,
      changePercent: 0,
      marketCap: marketCap ?? 0,
      peRatio: peRatio ?? undefined,
      dividendYield: dividendYield ?? undefined,
      revenueGrowthYoY: revenueGrowthYoY ?? undefined,
      netMargin: netMargin ?? undefined,
      roe: roe ?? undefined,
      revenue: revenue ?? undefined,
      netIncome: netIncome ?? undefined,
      epsDiluted: eps ?? undefined,
      fiscalYear: row.fiscal_year ?? undefined,
      fiscalPeriod: row.fiscal_period ?? undefined,
      sentimentScore: 0,
      sentimentLabel: 'Neutral',
      volume: 0,
    });
  }

  results.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  return { warehouseReady: true, results: results.slice(0, limit) };
}

// ---- Search (port of edgarService.searchCompanies) ------------------------
async function searchCompanies(q, limit = 10) {
  const conn = await getConnection();
  if (!conn) return [];
  const term = `%${q.trim()}%`;
  if (term === '%%') return [];
  try {
    const reader = await conn.runAndReadAll(
      `SELECT ticker, name, sector_label
       FROM companies
       WHERE name ILIKE ? OR ticker ILIKE ?
       ORDER BY (ticker ILIKE ?) DESC, name
       LIMIT ?`,
      [term, term, term, limit]
    );
    return reader.getRowObjectsJson();
  } catch (err) {
    console.error('[svc-edgar] searchCompanies failed:', err);
    return [];
  }
}

// ---- Company fundamentals (by ticker) -------------------------------------
async function getCompanyFundamentals(ticker) {
  const ready = await isWarehouseReady();
  const clean = String(ticker).trim().toUpperCase();
  if (!ready) return { warehouseReady: false, fundamentals: null };
  const { warehouseReady, results } = await getScreenerResults({ searchQuery: clean, limit: 10 });
  const row = results.find((r) => r.symbol === clean);
  if (!warehouseReady || !row) return { warehouseReady, fundamentals: null };
  const fy = row.fiscalYear ? ` (FY${row.fiscalYear}${row.fiscalPeriod ? ` ${row.fiscalPeriod}` : ''})` : '';
  return {
    warehouseReady: true,
    fundamentals: {
      symbol: row.symbol,
      name: row.name,
      sector: row.sector,
      revenueGrowthYoY: row.revenueGrowthYoY,
      netMargin: row.netMargin,
      roe: row.roe,
      peRatio: row.peRatio,
      revenue: row.revenue,
      netIncome: row.netIncome,
      epsDiluted: row.epsDiluted,
      source: `SEC EDGAR company facts${fy}`,
    },
  };
}

// ---- Sector stats (P1-2 audit fix) -----------------------------------------
// Per-sector medians + sorted distributions of the four fundamentals factors
// (revenueGrowthYoY, netMargin, roe, peRatio) computed from the warehouse with
// the SAME formulas as the screener, cached in memory for 24h. svc-verdict uses
// the distributions to rank a company's fundamentals as a percentile WITHIN its
// sector instead of scoring against absolute thresholds.
const SECTOR_STATS_TTL_MS = 24 * 60 * 60 * 1000;
let sectorStatsCache = null; // { at, computedAt, sectors, bySector }

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function getSectorStats() {
  if (sectorStatsCache && Date.now() - sectorStatsCache.at < SECTOR_STATS_TTL_MS) {
    return { ...sectorStatsCache, cached: true };
  }
  const conn = await getConnection();
  if (!conn) return { warehouseReady: false };
  if (!(await isWarehouseReady())) return { warehouseReady: false };

  const sql = `${revenueCteSql()}
    SELECT c.ticker, c.sector_label, m.revenue, m.net_income, m.eps_diluted,
           m.stockholders_equity, p.rev_prior
    FROM companies c
    JOIN metrics_latest m ON m.cik = c.cik
    LEFT JOIN prior p ON p.cik = c.cik
  `;
  let rows;
  try {
    const reader = await conn.runAndReadAll(sql, [...REVENUE_TAGS]);
    rows = reader.getRowObjectsJson();
  } catch (err) {
    console.error('[svc-edgar] sector-stats query failed:', err);
    return { warehouseReady: true };
  }

  const priceMap = loadPriceMap();
  const bySector = new Map(); // sector -> { growth[], margin[], roe[], pe[], n }
  for (const row of rows) {
    const revenue = num(row.revenue);
    const netIncome = num(row.net_income);
    const eps = num(row.eps_diluted);
    const equity = num(row.stockholders_equity);
    const revPrior = num(row.rev_prior);
    const priceEntry = priceMap[String(row.ticker || '').toUpperCase()];
    const price = priceEntry?.price;
    const hasPrice = typeof price === 'number' && Number.isFinite(price) && price > 0;

    // Same formulas as the screener rows — single source of truth for basis.
    const growth = revenue && revPrior && revPrior > 0 ? ((revenue - revPrior) / revPrior) * 100 : null;
    const margin = revenue && netIncome !== null ? (netIncome / revenue) * 100 : null;
    const roe = equity && equity > 0 && netIncome !== null ? (netIncome / equity) * 100 : null;
    const pe = hasPrice && eps && eps > 0 ? price / eps : (priceEntry?.peRatio ?? null);

    const sector = row.sector_label ?? 'Unknown';
    let bucket = bySector.get(sector);
    if (!bucket) {
      bucket = { growth: [], margin: [], roe: [], pe: [], n: 0 };
      bySector.set(sector, bucket);
    }
    bucket.n++;
    if (growth !== null) bucket.growth.push(growth);
    if (margin !== null) bucket.margin.push(margin);
    if (roe !== null) bucket.roe.push(roe);
    if (pe !== null && pe > 0) bucket.pe.push(pe);
  }

  const sectors = {};
  for (const [sector, b] of bySector) {
    for (const k of ['growth', 'margin', 'roe', 'pe']) b[k].sort((a, z) => a - z);
    sectors[sector] = { growth: median(b.growth), margin: median(b.margin), roe: median(b.roe), pe: median(b.pe), n: b.n };
  }
  sectorStatsCache = { at: Date.now(), computedAt: Date.now(), sectors, bySector };
  return { ...sectorStatsCache, cached: false };
}

// ---- HTTP surface ----
const { app, listen, close } = await startService({
  name: 'svc-edgar',
  port: Number(process.env.PORT || 8002),
  healthDeps: async () => {
    const ready = await isWarehouseReady();
    return { ok: true, warehouseReady: ready, priceMapEntries: Object.keys(loadPriceMap()).length };
  },
});

app.get('/sector-stats', async (req) => {
  const out = await getSectorStats();
  if (out.warehouseReady === false) return { warehouseReady: false, sectors: {} };
  const base = { warehouseReady: true, cached: out.cached, computedAt: new Date(out.computedAt).toISOString(), sectors: out.sectors };
  const sector = req.query?.sector;
  if (!sector) return base;
  // Case-insensitive sector lookup; distributions enable percentile ranking.
  const key = Object.keys(out.sectors).find((s) => s.toLowerCase() === String(sector).trim().toLowerCase());
  if (!key) return { ...base, sector, known: false, stats: null, distributions: null };
  const b = out.bySector.get(key);
  return {
    ...base,
    sector: key,
    known: true,
    stats: base.sectors[key],
    distributions: { growth: b.growth, margin: b.margin, roe: b.roe, pe: b.pe },
  };
});

/** ScreenerFilter query params (src/types/index.ts) → typed filters. */
function filtersFromQuery(q) {
  const numOrUndef = (v) => (v === undefined || v === '' ? undefined : Number(v));
  return {
    sector: q.sector,
    minMarketCap: numOrUndef(q.minMarketCap),
    maxMarketCap: numOrUndef(q.maxMarketCap),
    minPE: numOrUndef(q.minPE),
    maxPe: numOrUndef(q.maxPe),
    minDividendYield: numOrUndef(q.minDividendYield),
    maxDividendYield: numOrUndef(q.maxDividendYield),
    minRevenueGrowth: numOrUndef(q.minRevenueGrowth),
    minNetMargin: numOrUndef(q.minNetMargin),
    minRoe: numOrUndef(q.minRoe),
    searchQuery: q.searchQuery || q.q,
    limit: numOrUndef(q.limit),
  };
}

// Named presets (?preset=quality|value|dividend|mega) fill ONLY missing keys —
// mirrors src/services/screenerService.ts PRESETS. Explicit query params win.
const PRESET_DEFAULTS = {
  quality: { minRevenueGrowth: 10, minNetMargin: 10, minRoe: 12 },
  value: { maxPe: 18, minNetMargin: 8 },
  dividend: { minDividendYield: 2 },
  mega: { minMarketCap: 100_000_000_000 },
};

app.get('/screener', async (req) => {
  const filters = filtersFromQuery(req.query);
  for (const [k, v] of Object.entries(PRESET_DEFAULTS[req.query.preset] || {})) {
    if (filters[k] === undefined) filters[k] = v;
  }
  const { warehouseReady, results } = await getScreenerResults(filters);
  return { warehouseReady, count: results.length, filters, results };
});

app.get('/search', async (req, reply) => {
  const q = String(req.query.q || '').trim();
  if (!q) return reply.status(400).send({ error: 'q is required' });
  const warehouseReady = await isWarehouseReady();
  const results = warehouseReady ? await searchCompanies(q, Math.min(Number(req.query.limit) || 10, 50)) : [];
  return { warehouseReady, count: results.length, results };
});

app.get('/company/:ticker', async (req, reply) => {
  const out = await getCompanyFundamentals(req.params.ticker);
  if (!out.fundamentals) {
    return reply.status(out.warehouseReady ? 404 : 503).send(out);
  }
  return out;
});

await listen();
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
