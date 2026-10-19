/**
 * Standalone smoke test for the EDGAR warehouse + EdgarService.
 * Run: node scripts/test-edgar.ts   (Node 24 strips TS types natively)
 */
import { DuckDBInstance } from '@duckdb/node-api';
// dynamic (non-literal) import so tsc doesn't demand allowImportingTsExtensions
const edgarModulePath = '../src/services/edgarService.ts';
const { edgarService } = (await import(edgarModulePath)) as typeof import('../src/services/edgarService');

const DB = decodeURIComponent(new URL('../data/warehouse.duckdb', import.meta.url).pathname);

const inst = await DuckDBInstance.create(DB, { access_mode: 'READ_ONLY' });
const conn = await inst.connect();

const q = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson();

console.log('--- row counts ---');
console.log(await q(`SELECT
  (SELECT COUNT(*) FROM companies) AS companies,
  (SELECT COUNT(*) FROM facts) AS facts,
  (SELECT COUNT(*) FROM metrics_latest) AS metrics_latest`));

console.log('--- AAPL / MSFT latest metrics ---');
console.log(
  await q(`SELECT c.ticker, m.fiscal_year, m.fiscal_period,
    m.revenue, m.net_income, m.eps_diluted, m.total_assets, m.total_debt,
    m.stockholders_equity, m.shares_outstanding, m.dividends_per_share
  FROM metrics_latest m JOIN companies c USING (cik)
  WHERE c.ticker IN ('AAPL','MSFT')`)
);

console.log('--- revenue history (AAPL, facts table, YoY check) ---');
console.log(
  await q(`SELECT "end", val FROM facts f JOIN companies c USING (cik)
    WHERE c.ticker='AAPL' AND f.tag='RevenueFromContractWithCustomerExcludingAssessedTax'
    ORDER BY "end" DESC LIMIT 3`)
);

await conn.closeSync();

console.log('--- edgarService.getScreenerResults (with sample priceMap) ---');
const results = await edgarService.getScreenerResults(
  { limit: 5 },
  { AAPL: 260, MSFT: 500, NVDA: 180, XOM: 115, JPM: 300 }
);
for (const r of results) {
  console.log(
    `${r.symbol.padEnd(6)} cap=${(r.marketCap / 1e12).toFixed(2)}T pe=${r.peRatio?.toFixed(1)}` +
      ` revGr=${r.revenueGrowthYoY?.toFixed(1)}% margin=${r.netMargin?.toFixed(1)}%` +
      ` roe=${r.roe?.toFixed(1)}% dy=${r.dividendYield?.toFixed(2)}% fy=${r.fiscalYear}`
  );
}

console.log('--- filter: maxPe=18 & minNetMargin=8 (value preset) ---');
const value = await edgarService.getScreenerResults(
  { maxPe: 18, minNetMargin: 8, limit: 10 },
  { AAPL: 260, MSFT: 500, KO: 70, PG: 165, JPM: 300, UNH: 320 }
);
console.log(value.map((r) => `${r.symbol}(pe=${r.peRatio?.toFixed(1)},m=${r.netMargin?.toFixed(1)}%)`).join(' '));

console.log('--- searchCompanies("apple") ---');
console.log(await edgarService.searchCompanies('apple', 3));
console.log('--- searchCompanies("oo") ---');
console.log(await edgarService.searchCompanies('oo', 3));
console.log('OK');
