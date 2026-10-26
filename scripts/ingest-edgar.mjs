#!/usr/bin/env node
/**
 * EDGAR data warehouse ingestion.
 *
 * Fetches SEC companyfacts for a universe of CIKs and stores normalized
 * fundamentals in DuckDB at data/warehouse.duckdb.
 *
 * Usage:
 *   node scripts/ingest-edgar.mjs          # S&P 500 constituents (default)
 *   node scripts/ingest-edgar.mjs --all    # every ticker in company_tickers.json (~10k)
 *
 * SEC policy: descriptive User-Agent required, max 10 req/s. We run at ~5 req/s
 * with retry/backoff on 403/429/5xx.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'warehouse.duckdb');
const ERROR_LOG = path.join(DATA_DIR, 'ingest-errors.log');

const UA = 'Research Platform <admin@researchplatform.dev>';
const ALL_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SP500_CSV_URL =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const COMPANYFACTS_URL = (cik) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`;

// ---- rate limiter: token bucket capped at 5 req/s (under SEC's 10 req/s) ----
const MIN_INTERVAL_MS = 200;
let lastRequestAt = 0;
async function throttle() {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function fetchJson(url, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.status === 403) {
      throw new Error(
        'SEC returned 403 — a descriptive User-Agent header is required. ' +
          `Send e.g. "${UA}".`
      );
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === retries) throw new Error(`HTTP ${res.status} for ${url}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  }
}

async function fetchText(url, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle();
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return await res.text();
    if (attempt === retries) throw new Error(`HTTP ${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

// ---- universes ----
async function getSp500Universe() {
  const csv = await fetchText(SP500_CSV_URL);
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',');
  const col = (name) => header.indexOf(name);
  const out = [];
  for (const line of lines.slice(1)) {
    // simple CSV parse (handles quoted commas)
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    const cik = parseInt(cells[col('CIK')], 10);
    if (!Number.isFinite(cik)) continue;
    out.push({
      cik,
      ticker: cells[col('Symbol')].trim().toUpperCase(),
      name: cells[col('Security')].trim(),
      sic: null,
      sector: cells[col('GICS Sector')]?.trim() || null,
    });
  }
  return out;
}

async function getAllUniverse() {
  const raw = await fetchJson(ALL_TICKERS_URL);
  // shape: { "0": { cik_str, ticker, title }, ... }
  return Object.values(raw).map((e) => ({
    cik: Number(e.cik_str),
    ticker: String(e.ticker).toUpperCase(),
    name: e.title,
    sic: null,
    sector: null, // company_tickers.json carries no sector/SIC
  }));
}

// ---- XBRL tag selection ----
const REVENUE_TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
  'SalesRevenueGoodsNet',
  'SalesRevenueServicesNet',
];
const NET_INCOME_TAGS = ['NetIncomeLoss', 'ProfitLoss'];
const EPS_TAGS = ['EarningsPerShareDiluted'];
const ASSETS_TAGS = ['Assets'];
const EQUITY_TAGS = ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'];
const GROSS_PROFIT_TAGS = ['GrossProfit'];
const OPERATING_INCOME_TAGS = ['OperatingIncomeLoss'];
const DEBT_TAGS = ['LongTermDebtNoncurrent', 'ShortTermBorrowings'];
const DEBT_FALLBACK_TAGS = ['LongTermDebt', 'DebtLongtermAndShorttermCombinedAmount'];
const DIVIDEND_TAGS = [
  'CommonStockDividendsPerShareDeclared',
  'CommonStockDividendsPerShareCashPaidAmount',
];
const SHARES_TAGS = ['EntityCommonStockSharesOutstanding']; // dei taxonomy

function isAnnual(v) {
  if (v.fp !== 'FY') return false;
  if (!/^10-K/.test(v.form || '')) return false;
  if (v.start) {
    const days = (new Date(v.end) - new Date(v.start)) / 86400000;
    if (days < 300) return false; // skip quarterly/year-to-date stubs
  }
  return true;
}

function collectAnnual(facts, taxonomy, tags) {
  const taxonomyFacts = facts?.[taxonomy];
  if (!taxonomyFacts) return [];
  const out = [];
  for (const tag of tags) {
    const entry = taxonomyFacts[tag];
    const units = entry?.units?.USD || entry?.units?.['USD/shares'];
    if (!units) continue;
    for (const v of units) {
      if (!isAnnual(v)) continue;
      out.push({
        tag,
        val: v.val,
        end: new Date(v.end),
        // `filed` = the date this value actually became public (the filing's
        // acceptance/filing date). Critical for look-ahead-free backtests.
        filed: v.filed ? new Date(v.filed) : null,
        fy: String(v.fy ?? ''),
        fp: v.fp,
        form: v.form,
        frame: v.frame ?? null,
      });
    }
  }
  return out;
}

function pickLatestAnnual(facts, taxonomy, tags) {
  const rows = collectAnnual(facts, taxonomy, tags);
  if (!rows.length) return null;
  return rows.reduce((best, r) => (!best || r.end > best.end ? r : best), null);
}

function pickLatestShares(facts) {
  const dei = facts?.dei;
  if (!dei) return null;
  const entry = dei.EntityCommonStockSharesOutstanding;
  if (!entry?.units?.shares) return null;
  let best = null;
  for (const v of entry.units.shares) {
    const end = new Date(v.end);
    if (!best || end > best.end) best = { ...v, end };
  }
  return best;
}

const ALL_TAG_FAMILIES = [
  REVENUE_TAGS, NET_INCOME_TAGS, EPS_TAGS, ASSETS_TAGS, EQUITY_TAGS,
  GROSS_PROFIT_TAGS, OPERATING_INCOME_TAGS, DEBT_TAGS, DEBT_FALLBACK_TAGS,
  DIVIDEND_TAGS,
];

async function extractCompanyMetrics(companyFacts) {
  // every annual value of the tags we care about -> facts table (enables YoY)
  const factRows = ALL_TAG_FAMILIES.flatMap((tags) =>
    collectAnnual(companyFacts, 'us-gaap', tags)
  );
  // dedupe (same val can appear under multiple tags)
  const seen = new Set();
  const uniqueFactRows = factRows.filter((r) => {
    const key = `${r.tag}|${r.end.toISOString()}|${r.val}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const rev = pickLatestAnnual(companyFacts, 'us-gaap', REVENUE_TAGS);
  const ni = pickLatestAnnual(companyFacts, 'us-gaap', NET_INCOME_TAGS);
  const eps = pickLatestAnnual(companyFacts, 'us-gaap', EPS_TAGS);
  const assets = pickLatestAnnual(companyFacts, 'us-gaap', ASSETS_TAGS);
  const equity = pickLatestAnnual(companyFacts, 'us-gaap', EQUITY_TAGS);
  const gp = pickLatestAnnual(companyFacts, 'us-gaap', GROSS_PROFIT_TAGS);
  const oi = pickLatestAnnual(companyFacts, 'us-gaap', OPERATING_INCOME_TAGS);
  let debtParts = DEBT_TAGS.map((t) =>
    pickLatestAnnual(companyFacts, 'us-gaap', [t])
  ).filter(Boolean);
  let debt = debtParts.reduce((s, p) => s + p.val, 0);
  if (debt === 0) {
    const fb = pickLatestAnnual(companyFacts, 'us-gaap', DEBT_FALLBACK_TAGS);
    debt = fb ? fb.val : null;
  }
  const dps = pickLatestAnnual(companyFacts, 'us-gaap', DIVIDEND_TAGS);
  const shares = pickLatestShares(companyFacts);

  const annuals = [rev, ni, eps, assets, equity, gp, oi].filter(Boolean);
  const latest = annuals.reduce(
    (acc, v) => (v && v.end > acc ? v.end : acc),
    new Date(0)
  );

  return {
    revenue: rev?.val ?? null,
    net_income: ni?.val ?? null,
    eps_diluted: eps?.val ?? null,
    total_assets: assets?.val ?? null,
    total_debt: debt || null,
    stockholders_equity: equity?.val ?? null,
    gross_profit: gp?.val ?? null,
    operating_income: oi?.val ?? null,
    fiscal_year: annuals.find((v) => v.end.getTime() === latest.getTime())?.fy ?? null,
    fiscal_period: annuals.find((v) => v.end.getTime() === latest.getTime())?.fp ?? null,
    shares_outstanding: shares?.val ?? null,
    dividends_per_share: dps?.val ?? null,
    fact_rows: uniqueFactRows,
  };
}

// ---- DuckDB ----
async function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();
  await conn.run(`
    CREATE TABLE IF NOT EXISTS companies (
      cik BIGINT PRIMARY KEY,
      ticker VARCHAR,
      name VARCHAR,
      sic VARCHAR,
      sector_label VARCHAR
    );
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS facts (
      cik BIGINT,
      tag VARCHAR,
      "end" DATE,
      val DOUBLE,
      fy VARCHAR,
      fp VARCHAR,
      form VARCHAR,
      frame VARCHAR
    );
  `);
  // Migration for warehouses created before filed_at existed: add the column
  // in place. Rows ingested before this change keep filed_at = NULL and are
  // handled conservatively by consumers (see backtest buildFundamentalsAsOf).
  await conn.run(`ALTER TABLE facts ADD COLUMN IF NOT EXISTS filed_at DATE;`);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS metrics_latest (
      cik BIGINT PRIMARY KEY,
      revenue DOUBLE,
      net_income DOUBLE,
      eps_diluted DOUBLE,
      total_assets DOUBLE,
      total_debt DOUBLE,
      stockholders_equity DOUBLE,
      gross_profit DOUBLE,
      operating_income DOUBLE,
      fiscal_year VARCHAR,
      fiscal_period VARCHAR,
      shares_outstanding DOUBLE,
      dividends_per_share DOUBLE
    );
  `);
  return { instance, conn };
}

async function main() {
  const args = process.argv.slice(2);
  const ingestAll = args.includes('--all');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`Fetching universe (${ingestAll ? 'all ~10k tickers' : 'S&P 500'})...`);
  const universe = ingestAll ? await getAllUniverse() : await getSp500Universe();
  console.log(`Universe size: ${universe.length}`);

  const { instance, conn } = await initDb();
  const logErr = (ticker, cik, msg) => {
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()}\t${ticker}\t${cik}\t${msg}\n`);
  };

  const insertCompany = (c) =>
    conn.run('INSERT OR REPLACE INTO companies VALUES (?, ?, ?, ?, ?)', [
      BigInt(c.cik), c.ticker, c.name, c.sic, c.sector,
    ]);
  const insertMetricRow = (cik, m) =>
    conn.run(
      `INSERT OR REPLACE INTO metrics_latest VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        BigInt(cik), m.revenue, m.net_income, m.eps_diluted,
        m.total_assets, m.total_debt, m.stockholders_equity,
        m.gross_profit, m.operating_income, m.fiscal_year, m.fiscal_period,
        m.shares_outstanding, m.dividends_per_share,
      ]
    );
  const insertFactRow = (cik, f) =>
    conn.run(
      'INSERT INTO facts VALUES (?, ?, CAST(? AS DATE), ?, ?, ?, ?, ?, CAST(? AS DATE))',
      [BigInt(cik), f.tag, f.end.toISOString().slice(0, 10), f.val, f.fy, f.fp, f.form, f.frame,
       f.filed ? f.filed.toISOString().slice(0, 10) : null]
    );

  let ok = 0, failed = 0, noFacts = 0;
  const t0 = Date.now();

  for (let i = 0; i < universe.length; i++) {
    const c = universe[i];
    try {
      const facts = await fetchJson(COMPANYFACTS_URL(c.cik));
      const m = await extractCompanyMetrics(facts.facts || {});
      await insertCompany(c);

      if (!m.revenue && !m.net_income) {
        noFacts++;
        logErr(c.ticker, c.cik, 'no annual us-gaap facts found');
      } else {
        await insertMetricRow(c.cik, m);
      }
      await conn.run('DELETE FROM facts WHERE cik = ?', [BigInt(c.cik)]);
      for (const f of m.fact_rows) {
        await insertFactRow(c.cik, f);
      }
      ok++;
    } catch (err) {
      failed++;
      logErr(c.ticker, c.cik, err.message);
    }

    if ((i + 1) % 25 === 0 || i === universe.length - 1) {
      const rate = ((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(
        `[${i + 1}/${universe.length}] ok=${ok} noFacts=${noFacts} failed=${failed} (${rate} co/s)`
      );
    }
  }

  conn.closeSync();
  await instance.closeSync?.();
  console.log(`Done. ingested=${ok} noFacts=${noFacts} failed=${failed} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`Errors logged to ${ERROR_LOG}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
