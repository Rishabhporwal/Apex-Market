import { existsSync } from 'node:fs';
import path from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { ScreenerFilter, ScreenerStockResult } from '@/types';

const WAREHOUSE_PATH = path.resolve(process.cwd(), 'data', 'warehouse.duckdb');

const REVENUE_TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
  'SalesRevenueGoodsNet',
  'SalesRevenueServicesNet',
];

export interface EdgarCompanySearchResult {
  ticker: string;
  name: string;
  sector: string | null;
}

interface WarehouseRow {
  cik: string;
  ticker: string;
  name: string;
  sector_label: string | null;
  revenue: number | null;
  net_income: number | null;
  eps_diluted: number | null;
  total_assets: number | null;
  total_debt: number | null;
  stockholders_equity: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  fiscal_year: string | null;
  fiscal_period: string | null;
  shares_outstanding: number | null;
  dividends_per_share: number | null;
  rev_prior: number | null;
}

/**
 * Read-only access to the EDGAR data warehouse (data/warehouse.duckdb,
 * built by scripts/ingest-edgar.mjs from SEC companyfacts XBRL data).
 */
class EdgarService {
  private connectionPromise: Promise<DuckDBConnection> | null = null;

  /** Opens (and caches) a read-only connection; null when warehouse is missing. */
  private async getConnection(): Promise<DuckDBConnection | null> {
    if (!existsSync(WAREHOUSE_PATH)) return null;
    if (!this.connectionPromise) {
      this.connectionPromise = DuckDBInstance.create(WAREHOUSE_PATH, {
        access_mode: 'READ_ONLY',
      }).then((instance) => instance.connect());
      this.connectionPromise.catch(() => {
        this.connectionPromise = null;
      });
    }
    try {
      return await this.connectionPromise;
    } catch {
      return null;
    }
  }

  /** True when the warehouse exists and has ingested companies. */
  async isWarehouseReady(): Promise<boolean> {
    const conn = await this.getConnection();
    if (!conn) return false;
    try {
      const r = await conn.runAndReadAll('SELECT COUNT(*) AS n FROM metrics_latest');
      const rows = r.getRowObjectsJson() as Array<{ n: number | string }>;
      return Number(rows[0]?.n ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Screen stocks against EDGAR fundamentals.
   *
   * Market cap = dei EntityCommonStockSharesOutstanding * reference price.
   * Pass priceMap (ticker -> live price) so marketCap/peRatio/dividendYield
   * reflect current prices; without it, price-dependent metrics are null.
   */
  async getScreenerResults(
    filters: ScreenerFilter,
    priceMap?: Record<string, number>
  ): Promise<ScreenerStockResult[]> {
    const conn = await this.getConnection();
    if (!conn) return [];

    const limit = Math.max(1, Math.min(filters.limit ?? 50, 1000));
    const search = filters.searchQuery?.trim();

    const sql = `
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

    const params: unknown[] = [...REVENUE_TAGS];
    if (filters.sector && filters.sector !== 'ALL') params.push(filters.sector);
    if (search) {
      params.push(`%${search}%`, `%${search}%`);
    }

    let rows: WarehouseRow[];
    try {
      const reader = await conn.runAndReadAll(sql, params as never);
      rows = reader.getRowObjectsJson() as unknown as WarehouseRow[];
    } catch (err) {
      console.error('[edgarService] query failed:', err);
      return [];
    }

    const results: ScreenerStockResult[] = [];
    for (const row of rows) {
      const ticker = row.ticker;
      const price = priceMap?.[ticker];
      const hasPrice = typeof price === 'number' && Number.isFinite(price) && price > 0;

      const revenue = num(row.revenue);
      const netIncome = num(row.net_income);
      const eps = num(row.eps_diluted);
      const equity = num(row.stockholders_equity);
      const shares = num(row.shares_outstanding);
      const dps = num(row.dividends_per_share);
      const revPrior = num(row.rev_prior);

      const marketCap =
        hasPrice && shares && shares > 0 ? shares * (price as number) : null;
      const peRatio = hasPrice && eps && eps > 0 ? (price as number) / eps : null;
      const netMargin = revenue && netIncome !== null ? (netIncome / revenue) * 100 : null;
      const roe =
        equity && equity > 0 && netIncome !== null ? (netIncome / equity) * 100 : null;
      const revenueGrowthYoY =
        revenue && revPrior && revPrior > 0 ? ((revenue - revPrior) / revPrior) * 100 : null;
      const dividendYield =
        hasPrice && dps && dps > 0 ? (dps / (price as number)) * 100 : null;

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
        price: hasPrice ? (price as number) : 0,
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
    return results.slice(0, limit);
  }

  /** Autocomplete: match company name or ticker. */
  async searchCompanies(q: string, limit = 10): Promise<EdgarCompanySearchResult[]> {
    const conn = await this.getConnection();
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
      return reader.getRowObjectsJson() as unknown as EdgarCompanySearchResult[];
    } catch (err) {
      console.error('[edgarService] searchCompanies failed:', err);
      return [];
    }
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const edgarService = new EdgarService();
export default edgarService;
