#!/usr/bin/env node
/**
 * svc-research (port 8006) — research data plane per ADR-001.
 *
 * Plain .mjs port of the monolith research routes:
 *  - /financials/:symbol  ← src/services/financialsService.ts (getCompanyOverview,
 *    getKeyFinancials, getFinancialStatements via yf.quoteSummary) + the query
 *    params/response shape of src/app/api/financials/route.ts
 *  - /filings/:symbol     ← src/services/filingsService.ts (sec-filings + fallbacks,
 *    earnings transcript highlights) + shape of src/app/api/filings/route.ts
 *  - /technical/:symbol   ← src/services/technicalService.ts (via shared/technical.mjs);
 *    candles come from svc-market-data (registry/SERVICES_JSON) with a direct
 *    yahoo-finance2 fallback.
 *
 * TTL caches: candles 10min, technicals 5min, financials/filings 10min —
 * same TtlCache (stale-on-error + single-flight) as every other service.
 */
import { startService, loadEnvLocal, TtlCache, httpClient } from '../shared/lib.mjs';
import { resolveService } from '../shared/discovery.mjs';
import { computeIndicators, getTechnicalSummary } from '../shared/technical.mjs';

loadEnvLocal();
const { default: YahooFinance } = await import('yahoo-finance2');
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const financialsCache = new TtlCache(10 * 60_000, 300, 'financials'); // fundamentals barely move intraday
const filingsCache = new TtlCache(10 * 60_000, 300, 'filings');
const candlesCache = new TtlCache(10 * 60_000, 500, 'candles');       // same TTL as svc-market-data
const technicalCache = new TtlCache(5 * 60_000, 300, 'technicals');   // computed analytics
const earningsCache = new TtlCache(60 * 60_000, 500, 'earnings');      // earnings dates move daily at most

// ---- data access (ports of financialsService.ts / filingsService.ts) ----

async function getCompanyOverview(symbol) {
  const cleanSymbol = symbol.trim().toUpperCase();
  return financialsCache.wrap(`overview|${cleanSymbol}`, async () => {
    try {
      const summary = await yf.quoteSummary(cleanSymbol, {
        modules: ['assetProfile', 'price'],
      });

      const profile = summary.assetProfile || {};
      const price = summary.price || {};

      return {
        symbol: cleanSymbol,
        name: price.shortName || price.longName || cleanSymbol,
        description: profile.longBusinessSummary || 'No detailed business summary available.',
        sector: profile.sector || 'Technology',
        industry: profile.industry || 'General',
        ceo: profile.companyOfficers?.[0]?.name || 'N/A',
        website: profile.website || '',
        employees: profile.fullTimeEmployees,
        headquarters: profile.city && profile.state ? `${profile.city}, ${profile.state}` : (profile.country || 'USA'),
        exchange: price.exchangeName || 'NASDAQ',
        currency: price.currency || 'USD',
      };
    } catch (error) {
      console.error(`Error fetching company overview for ${symbol}:`, error?.message || error);
      return {
        symbol: cleanSymbol,
        name: cleanSymbol,
        description: `Financial profile for ${cleanSymbol}.`,
        sector: 'Equities',
        industry: 'Diversified',
        exchange: 'US Exchange',
        currency: 'USD',
      };
    }
  });
}

async function getKeyFinancials(symbol) {
  const cleanSymbol = symbol.trim().toUpperCase();
  return financialsCache.wrap(`key|${cleanSymbol}`, async () => {
    // getKeyFinancials throws in the monolith on failure — preserve that.
    const summary = await yf.quoteSummary(cleanSymbol, {
      modules: [
        'defaultKeyStatistics',
        'financialData',
        'summaryDetail',
        'price',
      ],
    });

    const stats = summary.defaultKeyStatistics || {};
    const fin = summary.financialData || {};
    const detail = summary.summaryDetail || {};
    const price = summary.price || {};

    return {
      symbol: cleanSymbol,
      marketCap: price.marketCap || detail.marketCap || 0,
      enterpriseValue: stats.enterpriseValue,
      trailingPE: detail.trailingPE || stats.trailingPE,
      forwardPE: detail.forwardPE || stats.forwardPE,
      pegRatio: stats.pegRatio,
      priceToSales: detail.priceToSalesTrailing12Months,
      priceToBook: stats.priceToBook,
      evToEbitda: stats.enterpriseToEbitda,
      profitMargin: fin.profitMargins || stats.profitMargins,
      operatingMargin: fin.operatingMargins || stats.operatingMargins,
      returnOnEquity: fin.returnOnEquity || stats.returnOnEquity,
      returnOnAssets: fin.returnOnAssets || stats.returnOnAssets,
      revenue: fin.totalRevenue,
      revenuePerShare: fin.revenuePerShare,
      quarterlyRevenueGrowth: fin.revenueGrowth,
      grossProfit: fin.grossProfits,
      ebitda: fin.ebitda,
      netIncome: stats.netIncomeToCommon,
      dilutedEPS: stats.trailingEps,
      totalCash: fin.totalCash,
      totalDebt: fin.totalDebt,
      debtToEquity: fin.debtToEquity,
      currentRatio: fin.currentRatio,
      freeCashflow: fin.freeCashflow,
      operatingCashflow: fin.operatingCashflow,
      beta: stats.beta || detail.beta,
      sharesOutstanding: stats.sharesOutstanding,
      dividendRate: detail.dividendRate,
      dividendYield: detail.dividendYield ? detail.dividendYield * 100 : undefined,
      payoutRatio: detail.payoutRatio ? detail.payoutRatio * 100 : undefined,
      targetMeanPrice: fin.targetMeanPrice,
      targetHighPrice: fin.targetHighPrice,
      targetLowPrice: fin.targetLowPrice,
      recommendationKey: fin.recommendationKey?.toUpperCase() || 'HOLD',
      numberOfAnalystOpinions: fin.numberOfAnalystOpinions,
    };
  });
}

function generateSyntheticFinancials(symbol) {
  const years = ['2023', '2024', '2025', '2026'];
  const baseRev = symbol === 'AAPL' ? 383e9 : symbol === 'NVDA' ? 60e9 : symbol === 'MSFT' ? 211e9 : 50e9;
  return years.map((yr, idx) => {
    const growthFactor = 1 + idx * 0.16;
    const rev = baseRev * growthFactor;
    const cost = rev * 0.45;
    const gross = rev - cost;
    const opex = rev * 0.22;
    const opIncome = gross - opex;
    const net = opIncome * 0.82;
    return {
      year: yr,
      revenue: Math.round(rev),
      costOfRevenue: Math.round(cost),
      grossProfit: Math.round(gross),
      operatingExpenses: Math.round(opex),
      operatingIncome: Math.round(opIncome),
      netIncome: Math.round(net),
      ebitda: Math.round(opIncome * 1.15),
      eps: Number((net / 3e9).toFixed(2)),
    };
  });
}

async function getFinancialStatements(symbol) {
  const cleanSymbol = symbol.trim().toUpperCase();
  return financialsCache.wrap(`statements|${cleanSymbol}`, async () => {
    try {
      const summary = await yf.quoteSummary(cleanSymbol, {
        modules: ['incomeStatementHistory'],
      });

      const history = summary.incomeStatementHistory?.incomeStatementHistory || [];
      if (!history || history.length === 0) {
        return generateSyntheticFinancials(cleanSymbol);
      }

      return history.map((item) => {
        const year = item.endDate ? new Date(item.endDate).getFullYear().toString() : '2025';
        return {
          year,
          revenue: item.totalRevenue || 0,
          costOfRevenue: item.costOfRevenue || 0,
          grossProfit: item.grossProfit || 0,
          operatingExpenses: item.totalOperatingExpenses || 0,
          operatingIncome: item.operatingIncome || 0,
          netIncome: item.netIncome || 0,
          ebitda: item.ebit || item.operatingIncome || 0,
          eps: Number((item.netIncome ? (item.netIncome / 1e9) : 0).toFixed(2)),
        };
      }).reverse();
    } catch (error) {
      console.warn(`Could not load real statements for ${symbol}, providing verified fallback model.`);
      return generateSyntheticFinancials(cleanSymbol);
    }
  });
}

function generateFilingKeyPoints(type, symbol) {
  if (type.includes('10-K')) {
    return [
      `Full year audited consolidated financial statements for ${symbol}.`,
      'Detailed business segment revenue breakdown and geographic performance.',
      'Management discussion of competitive risks and long-term liquidity commitments.',
    ];
  }
  if (type.includes('10-Q')) {
    return [
      `Quarterly financial performance review and sequential margin comparisons.`,
      'Cash and short-term investment holdings evaluation.',
      'Disclosures on off-balance sheet arrangements and commitments.',
    ];
  }
  if (type.includes('8-K')) {
    return [
      'Unscheduled material corporate event or earnings press release announcement.',
      'Furnished financial attachments under Regulation FD.',
    ];
  }
  return [
    `Official regulatory compliance submission filed with the U.S. SEC for ${symbol}.`,
  ];
}

async function getSecFilings(symbol) {
  const cleanSymbol = symbol.trim().toUpperCase();
  return filingsCache.wrap(`sec|${cleanSymbol}`, async () => {
    try {
      const summary = await yf.quoteSummary(cleanSymbol, {
        modules: ['secFilings'],
      });

      const rawFilings = summary.secFilings?.filings || [];
      if (rawFilings.length > 0) {
        return rawFilings.slice(0, 15).map((f, idx) => {
          const type = f.type || '10-Q';
          return {
            id: `sec-${cleanSymbol}-${idx}-${f.date}`,
            type,
            title: f.title || `${type} Report for ${cleanSymbol}`,
            date: f.date ? new Date(f.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Recent',
            edgarUrl: f.edgarUrl || `https://www.sec.gov/edgar/searchedgar/companysearch?company=${cleanSymbol}`,
            keyPoints: generateFilingKeyPoints(type, cleanSymbol),
            periodEnd: f.periodEnd ? new Date(f.periodEnd).toLocaleDateString('en-US') : undefined,
          };
        });
      }
    } catch (error) {
      console.warn(`Could not load live SEC filings for ${symbol}, providing verified regulatory index.`);
    }

    // High quality verified standard regulatory filings for symbol
    return [
      {
        id: `sec-${cleanSymbol}-1`,
        type: '10-K',
        title: `Form 10-K Annual Report (Fiscal Year)`,
        date: 'Jan 31, 2026',
        edgarUrl: `https://www.sec.gov/edgar/searchedgar/companysearch?company=${cleanSymbol}`,
        keyPoints: [
          'Audited Consolidated Financial Statements and Notes.',
          'Management Discussion & Analysis (MD&A) of Financial Condition and Operations.',
          'Comprehensive Risk Factors disclosure and segment operational results.',
          'Assessment of internal controls over financial reporting (Sarbanes-Oxley 404).',
        ],
      },
      {
        id: `sec-${cleanSymbol}-2`,
        type: '10-Q',
        title: `Form 10-Q Quarterly Report (Q3)`,
        date: 'Nov 04, 2025',
        edgarUrl: `https://www.sec.gov/edgar/searchedgar/companysearch?company=${cleanSymbol}`,
        keyPoints: [
          'Unaudited quarterly condensed balance sheets and cash flows.',
          'Quarter-over-quarter revenue and gross margin variance analysis.',
          'Liquidity and capital resources discussion including share buyback activity.',
        ],
      },
      {
        id: `sec-${cleanSymbol}-3`,
        type: '8-K',
        title: `Form 8-K Current Report: Material Corporate Event`,
        date: 'Oct 15, 2025',
        edgarUrl: `https://www.sec.gov/edgar/searchedgar/companysearch?company=${cleanSymbol}`,
        keyPoints: [
          'Disclosure under Item 2.02: Results of Operations and Financial Condition.',
          'Presentation materials and press release furnished as Exhibit 99.1.',
        ],
      },
      {
        id: `sec-${cleanSymbol}-4`,
        type: 'Form 4',
        title: `Statement of Changes in Beneficial Ownership of Securities`,
        date: 'Sep 28, 2025',
        edgarUrl: `https://www.sec.gov/edgar/searchedgar/companysearch?company=${cleanSymbol}`,
        keyPoints: [
          'Executive and Director insider transaction report under Rule 16a-3.',
          'Scheduled 10b5-1 predetermined trading plan disposition and option exercises.',
        ],
      },
    ];
  });
}

/** Static quarterly transcript breakdowns (same as filingsService). */
const TRANSCRIPT_CACHE_KEY = 'transcripts-static';
const TRANSCRIPTS = [
  {
    quarter: 'Q4 2025 / Q1 2026',
    date: 'Feb 2026',
    revenueSurprisePercent: 3.8,
    epsSurprisePercent: 6.2,
    executiveSummary: `Management expressed strong confidence in high-margin enterprise demand and next-generation product architectural rollouts. Operating leverage improved as operating expense growth moderated below revenue expansion.`,
    positiveHighlights: [
      'Double-digit expansion in recurring software and ecosystem gross margins.',
      'Free cash flow conversion reached 32% of total net revenue.',
      'Customer net retention rates remained above 118% across tier-1 enterprise accounts.',
      'Board increased capital return program authorization by $10B.',
    ],
    concernsOrHeadwinds: [
      'Foreign exchange currency fluctuations created a 1.2% headwind to reported international revenue.',
      'Extended procurement review cycles observed in select macroeconomic sensitive verticals.',
      'Capital expenditures remain elevated due to AI and cloud data center capacity investments.',
    ],
    futureGuidance: `Next fiscal quarter revenue guided in the range of 8% to 11% year-over-year growth, with gross margins stabilizing around 44-46%. Management expects full-year operating margins to expand by 150 basis points.`,
  },
  {
    quarter: 'Q3 2025',
    date: 'Oct 2025',
    revenueSurprisePercent: 2.1,
    epsSurprisePercent: 4.5,
    executiveSummary: `Solid quarterly print driven by resilient core customer demand and supply chain normalization. Working capital efficiency improved inventory turnover days.`,
    positiveHighlights: [
      'Gross margins expanded 110 bps sequentially due to product mix optimization.',
      'International segment revenues delivered upside vs consensus expectations.',
      'Cash flow from operations covered 100% of capital expenditures and dividend commitments.',
    ],
    concernsOrHeadwinds: [
      'Component pricing volatility in specialized memory and semiconductor supply chains.',
      'Slightly softer consumer hardware demand partially offset by enterprise software strength.',
    ],
    futureGuidance: `Reiterated full-year revenue outlook while tightening operating expense envelope by 200 bps.`,
  },
];

async function getEarningsTranscriptHighlights(symbol) {
  const cleanSymbol = symbol.trim().toUpperCase();
  return filingsCache.wrap(`transcripts|${cleanSymbol}`, async () => TRANSCRIPTS);
}

// ---- candles: svc-market-data first, direct Yahoo fallback ----

function period1For(timeframe) {
  const now = new Date();
  const period1 = new Date();
  switch (timeframe) {
    case '1d': period1.setDate(now.getDate() - 2); break;
    case '5d': period1.setDate(now.getDate() - 7); break;
    case '1mo': period1.setMonth(now.getMonth() - 1); break;
    case '6mo': period1.setMonth(now.getMonth() - 6); break;
    case '2y': period1.setFullYear(now.getFullYear() - 2); break;
    case '5y': period1.setFullYear(now.getFullYear() - 5); break;
    default: period1.setFullYear(now.getFullYear() - 1);
  }
  return period1.toISOString().split('T')[0];
}

async function fetchCandlesDirect(symbol, timeframe, interval) {
  // Fallback path — identical chart call to svc-market-data.
  try {
    const chartResult = await yf.chart(symbol, { period1: period1For(timeframe), interval });
    const quotes = chartResult.quotes || [];
    return quotes
      .filter((q) => q.open !== null && q.close !== null && q.high !== null && q.low !== null)
      .map((q) => ({
        time: new Date(q.date).toISOString().split('T')[0],
        open: Number((q.open ?? 0).toFixed(2)),
        high: Number((q.high ?? 0).toFixed(2)),
        low: Number((q.low ?? 0).toFixed(2)),
        close: Number((q.close ?? 0).toFixed(2)),
        volume: q.volume || 0,
      }));
  } catch {
    return [];
  }
}

async function getHistoricalCandles(symbol, timeframe = '1y', interval = '1d', ctx = null) {
  const cleanSymbol = String(symbol).trim().toUpperCase();
  return candlesCache.wrap(`${cleanSymbol}|${timeframe}|${interval}`, async () => {
    try {
      const base = await resolveService('market-data');
      const res = await httpClient.fetch(
        `${base}/candles/${encodeURIComponent(cleanSymbol)}?timeframe=${encodeURIComponent(timeframe)}&interval=${encodeURIComponent(interval)}`,
        { ctx, span: 'research.market-data.candles', timeoutMs: 20_000 }
      );
      if (res.ok && Array.isArray(res.json?.candles)) return res.json.candles;
      console.warn(`[svc-research] market-data candles unhealthy (status ${res.status}) — falling back to direct Yahoo`);
    } catch (err) {
      console.warn(`[svc-research] market-data unreachable (${err.message}) — falling back to direct Yahoo`);
    }
    return fetchCandlesDirect(cleanSymbol, timeframe, interval);
  });
}

// ---- HTTP surface ----

const { app, listen, close } = await startService({
  name: 'svc-research',
  port: Number(process.env.PORT || 8006),
  healthDeps: async () => ({
    ok: true,
    financialsCache: financialsCache.size,
    filingsCache: filingsCache.size,
    candlesCache: candlesCache.size,
    technicalCache: technicalCache.size,
  }),
});

const SECTIONS = ['overview', 'key-metrics', 'statements', 'all'];
const TYPES = ['filings', 'transcripts', 'all'];

app.get('/financials/:symbol', async (req, reply) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  const section = String(req.query.section || 'all');
  if (!SECTIONS.includes(section)) {
    return reply.status(400).send({ error: `invalid section (sections: ${SECTIONS.join(',')})` });
  }
  try {
    if (section === 'overview') return await getCompanyOverview(symbol);
    if (section === 'key-metrics') return await getKeyFinancials(symbol);
    if (section === 'statements') return await getFinancialStatements(symbol);

    // Default 'all': combined financial payload (same as the monolith route)
    const [overview, metrics, statements] = await Promise.all([
      getCompanyOverview(symbol),
      getKeyFinancials(symbol),
      getFinancialStatements(symbol),
    ]);
    return { overview, metrics, statements };
  } catch (err) {
    return reply.status(502).send({ error: err?.message || 'Financials service failed' });
  }
});

app.get('/filings/:symbol', async (req, reply) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  const type = String(req.query.type || 'all');
  if (!TYPES.includes(type)) {
    return reply.status(400).send({ error: `invalid type (types: ${TYPES.join(',')})` });
  }
  try {
    if (type === 'filings') return await getSecFilings(symbol);
    if (type === 'transcripts') return await getEarningsTranscriptHighlights(symbol);

    const [filings, transcripts] = await Promise.all([
      getSecFilings(symbol),
      getEarningsTranscriptHighlights(symbol),
    ]);
    return { filings, transcripts };
  } catch (err) {
    return reply.status(502).send({ error: err?.message || 'Filings service failed' });
  }
});

app.get('/technical/:symbol', async (req, reply) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  const timeframe = String(req.query.timeframe || '1y');
  const interval = String(req.query.interval || '1d');
  try {
    const payload = await technicalCache.wrap(`${symbol}|${timeframe}|${interval}`, async () => {
      const candles = await getHistoricalCandles(symbol, timeframe, interval, req.traceCtx);
      const summary = getTechnicalSummary(symbol, candles);
      const indicatorSeries = computeIndicators(candles);
      return {
        symbol,
        summary,
        indicatorSeries: indicatorSeries.slice(-60), // Latest 60 periods for quick chart/gauge inspection
      };
    });
    return payload;
  } catch (err) {
    return reply.status(502).send({ error: err?.message || 'Technical analysis service failed' });
  }
});

// GET /earnings/:symbol — next earnings date + days until it (earnings-calendar awareness)
app.get('/earnings/:symbol', async (req, reply) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  try {
    const payload = await earningsCache.wrap(symbol, async () => {
      const summary = await yf.quoteSummary(symbol, { modules: ['calendarEvents', 'price'] });
      const cal = summary?.calendarEvents || {};
      const raw = cal.earnings?.earningsDate;
      // yahoo-finance2 may return numeric epochs, {raw: epoch}, or ISO strings depending on version/options
      const toMs = (d) => {
        if (d instanceof Date) return d.getTime();
        if (typeof d === 'number') return d * 1000;
        if (typeof d === 'string') { const t = Date.parse(d); return Number.isNaN(t) ? null : t; }
        if (d && typeof d.raw === 'number') return d.raw * 1000;
        if (d && d.raw instanceof Date) return d.raw.getTime();
        if (d && typeof d.getTime === 'function') return d.getTime();
        return null;
      };
      const dates = (Array.isArray(raw) ? raw : [raw]).map(toMs).filter((ms) => ms !== null);
      // Take the next upcoming date; Yahoo may return a range (start/end)
      const now = Date.now();
      const next = dates.sort((a, b) => a - b).find((ms) => ms >= now - 24 * 3600 * 1000);
      return {
        symbol,
        earningsDate: next ? new Date(next).toISOString() : null,
        earningsDateRaw: dates.length ? dates.map((ms) => new Date(ms).toISOString()) : [],
        daysUntil: next ? Math.round((next - now) / (24 * 3600 * 1000)) : null,
        fetchedAt: now,
      };
    });
    return payload;
  } catch (err) {
    return reply.status(502).send({ error: err?.message || 'Earnings service failed' });
  }
});

await listen();

process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
