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
 * Usage: node scripts/refresh-prices.mjs [--limit=N]   (limit for testing)
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

// ---- main ----
async function main() {
  // Read the universe from the main warehouse via a file snapshot (avoids lock)
  const snapDir = fs.mkdtempSync(path.join(ROOT, 'data', 'rp-snap-'));
  const snapshot = path.join(snapDir, 'warehouse.duckdb');
  fs.copyFileSync(WAREHOUSE, snapshot);
  const snapDb = await DuckDBInstance.create(snapshot, { access_mode: 'READ_ONLY' });
  const snapConn = await snapDb.connect();
  const rs = await snapConn.runAndReadAll('SELECT ticker FROM companies ORDER BY ticker');
  const tickers = rs.getRowObjects().map((r) => String(r.ticker)).filter((t) => t && t !== 'null');
  await snapConn.closeSync();
  fs.rmSync(snapDir, { recursive: true, force: true });
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

  // Also write a JSON snapshot for the API layer to consume cheaply
  const jsonPath = path.join(ROOT, 'data', 'latest-prices.json');
  fs.writeFileSync(jsonPath, JSON.stringify(
    Object.fromEntries(ok.map((q) => [q.ticker, q])),
    null, 0
  ));
  console.log(`Snapshot written: data/latest-prices.json`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
