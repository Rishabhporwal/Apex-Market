#!/usr/bin/env node
/**
 * Daily refresh pipeline — keeps the platform's data fresh without touching
 * the main EDGAR warehouse (which is ingested rarely and expensively).
 *
 * What it does:
 *  1. Fetches live quotes for every company in the warehouse (Yahoo, batched).
 *  2. Stores them in a SEPARATE data/prices.duckdb (prices table: ticker, date, close, volume).
 *     → Why a second file? DuckDB allows ONE writer; the dev server holds the main
 *       warehouse open read-only. A side file means price refreshes never conflict
 *       with the warehouse, and the screener can join live prices without lock fights.
 *  3. Designed to run daily via cron/launchd:  npm run refresh:prices
 *
 * Usage: node scripts/refresh-prices.mjs [--limit=N]     (limit for testing)
 *        node scripts/refresh-prices.mjs --index-universe (fast pre-market mode)
 *
 * --index-universe refreshes ONLY the index constituents (~900 names: S&P 500 +
 * S&P 400), which finishes in ~15 min instead of ~90. This is what the daily
 * scheduler runs at 07:30 ET so prices are fresh before the 08:30 ET analysis.
 * In this mode latest-prices.json is MERGED (index quotes overlay the existing
 * snapshot) so the other warehouse names keep their last-known prices.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = process.cwd();
const WAREHOUSE = path.join(ROOT, 'data', 'warehouse.duckdb');
const PRICES_DB = path.join(ROOT, 'data', 'prices.duckdb');

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const INDEX_MODE = args.includes('--index-universe');

if (!fs.existsSync(WAREHOUSE)) {
  console.error('FATAL: data/warehouse.duckdb not found. Run the EDGAR ingest first.');
  process.exit(1);
}

// ---- Yahoo batch fetch with rate-limit politeness ----
const { default: YahooFinance } = await import('yahoo-finance2');
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

async function fetchQuotesBatch(symbols) {
  const results = [];
  for (const s of symbols) {
    try {
      const q = await yf.quote(s);
      results.push({
        ticker: s,
        price: q.regularMarketPrice ?? null,
        changePercent: q.regularMarketChangePercent ?? null,
        volume: q.regularMarketVolume ?? null,
        marketCap: q.marketCap ?? null,
        peRatio: q.trailingPE ?? null,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`  ! ${s}: ${err?.message || err}`);
      results.push({ ticker: s, price: null, fetchedAt: new Date().toISOString(), error: String(err?.message || err) });
    }
    await new Promise((r) => setTimeout(r, 250)); // ~4 req/s — under Yahoo's tolerance
  }
  return results;
}

// ---- index universes (fast pre-market mode) ----
const UA = 'Research Platform <admin@researchplatform.dev>';
const SP500_CSV_URL =
  'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const SP400_WIKI_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies';

async function fetchText(url, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return await res.text();
    if (attempt === retries) throw new Error(`HTTP ${res.status} for ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

/** S&P 500 symbols from the datasets/constituents.csv (same source as ingest-edgar). */
async function getSp500Symbols() {
  const csv = await fetchText(SP500_CSV_URL);
  const lines = csv.trim().split('\n');
  const symCol = lines[0].split(',').indexOf('Symbol');
  const out = new Set();
  for (const line of lines.slice(1)) {
    // simple CSV parse tolerant of quoted commas
    const cells = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    const sym = (cells[symCol] || '').trim().toUpperCase();
    if (sym) out.add(sym);
  }
  return out;
}

/** S&P 400 MidCap symbols from the Wikipedia constituents table (same parse as ingest-edgar). */
async function getSp400Symbols() {
  const html = await fetchText(SP400_WIKI_URL);
  const tableM = html.match(/<table[^>]*id="constituents"[^>]*>([\s\S]*?)<\/table>/);
  if (!tableM) throw new Error('S&P 400 constituents table not found on Wikipedia page');
  const out = new Set();
  for (const row of tableM[1].split('<tr').slice(2)) {
    const cells = row.split('<td').slice(1).map((c) => c.split('</td>')[0]);
    if (cells.length < 3) continue;
    let sym = null;
    const hrefM = cells[0].match(/quote\/(?:XNYS|XNAS|ARCX|BATS):([A-Za-z0-9.\-]+)/);
    if (hrefM) sym = hrefM[1].toUpperCase();
    else {
      const aM = cells[0].match(/<a[^>]*>([^<]+)<\/a>/);
      sym = (aM ? aM[1] : cells[0].replace(/<[^>]+>/g, '')).trim().toUpperCase();
    }
    if (sym && /^[A-Z][A-Z0-9.\-]{0,6}$/.test(sym)) out.add(sym.replace(/\./g, '-')); // Yahoo share-class format
  }
  return out;
}

/** ~900 tickers: S&P 500 ∪ S&P 400, deduped. No warehouse lookup needed. */
async function getIndexUniverse() {
  const [sp500, sp400] = await Promise.all([getSp500Symbols(), getSp400Symbols()]);
  const tickers = [...new Set([...sp500, ...sp400])].sort();
  console.log(`Index universe: ${sp500.size} S&P 500 + ${sp400.size} S&P 400 → ${tickers.length} unique tickers`);
  return tickers;
}

// ---- main ----
async function main() {
  let tickers;
  if (INDEX_MODE) {
    tickers = await getIndexUniverse();
  } else {
    // Read the universe from the main warehouse via a file snapshot (avoids lock)
  const snapDir = fs.mkdtempSync(path.join(ROOT, 'data', 'rp-snap-'));
  const snapshot = path.join(snapDir, 'warehouse.duckdb');
  fs.copyFileSync(WAREHOUSE, snapshot);
  const snapDb = await DuckDBInstance.create(snapshot, { access_mode: 'READ_ONLY' });
  const snapConn = await snapDb.connect();
  const rs = await snapConn.runAndReadAll('SELECT ticker FROM companies ORDER BY ticker');
    const allTickers = rs.getRowObjects().map((r) => String(r.ticker)).filter((t) => t && t !== 'null');
    tickers = allTickers;
    await snapConn.closeSync();
    fs.rmSync(snapDir, { recursive: true, force: true });
  }
  console.log(`Universe: ${tickers.length} tickers`);

  const target = LIMIT !== Infinity ? tickers.slice(0, LIMIT) : tickers;
  console.log(`Fetching quotes for ${target.length} tickers (batched, ~4/s)...`);

  const all = [];
  const BATCH = 40;
  for (let i = 0; i < target.length; i += BATCH) {
    const batch = target.slice(i, i + BATCH);
    const quotes = await fetchQuotesBatch(batch);
    all.push(...quotes);
    console.log(`  [${Math.min(i + BATCH, target.length)}/${target.length}] fetched`);
  }

  const ok = all.filter((q) => q.price != null);
  console.log(`Fetched ${ok.length}/${all.length} quotes successfully`);

  // Upsert into prices.duckdb (own file, own lock — no conflict with warehouse)
  const db = await DuckDBInstance.create(PRICES_DB);
  const conn = await db.connect();
  conn.run(`
    CREATE TABLE IF NOT EXISTS prices (
      ticker VARCHAR,
      price DOUBLE,
      change_percent DOUBLE,
      volume BIGINT,
      market_cap DOUBLE,
      pe_ratio DOUBLE,
      fifty_two_week_high DOUBLE,
      fifty_two_week_low DOUBLE,
      fetched_at TIMESTAMP
    )
  `);
  conn.run(`DELETE FROM prices WHERE fetched_at < CURRENT_TIMESTAMP - INTERVAL 7 DAY`);

  // Insert via awaited runs (sync conn.run returns before the write applies)
  const today = new Date().toISOString();
  for (const q of ok) {
    await conn.run(`INSERT INTO prices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      q.ticker, q.price, q.changePercent, q.volume, q.marketCap, q.peRatio, q.fiftyTwoWeekHigh, q.fiftyTwoWeekLow, today,
    ]);
  }
  const count = await conn.runAndReadAll('SELECT COUNT(*) AS n FROM prices');
  console.log(`prices.duckdb now holds ${count.getRowObjects()[0].n.toString()} rows`);
  await conn.run('CHECKPOINT'); // flush WAL so read-only consumers see everything
  conn.closeSync();

  // Also write a JSON snapshot for the API layer to consume cheaply.
  // Index mode MERGES into the existing snapshot: it only fetches ~900 index
  // names, and clobbering the file would drop every other warehouse ticker.
  const jsonPath = path.join(ROOT, 'data', 'latest-prices.json');
  let finalMap = Object.fromEntries(ok.map((q) => [q.ticker, q]));
  if (INDEX_MODE) {
    try {
      const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      finalMap = { ...prev, ...finalMap };
      console.log(`Merged with existing snapshot (${Object.keys(prev).length} prior entries)`);
    } catch { /* no prior snapshot — write fresh */ }
  }
  fs.writeFileSync(jsonPath, JSON.stringify(finalMap, null, 0));
  console.log(`Snapshot written: data/latest-prices.json (${Object.keys(finalMap).length} tickers)`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
