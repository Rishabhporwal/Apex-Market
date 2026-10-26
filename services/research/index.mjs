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
import fs from 'node:fs';
import path from 'node:path';
import { startService, loadEnvLocal, TtlCache, httpClient, REPO_ROOT } from '../shared/lib.mjs';
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

// ---- SEC filing-context retrieval (EDGAR; public data, no keys) ----
//
// GET /filing-context/:symbol?q=...&form=10-K|10-Q
//
// Pipeline: ticker→CIK (cached memory 24h + disk) → submissions index → latest
// filing of the requested form → document fetch → HTML→text extraction →
// chunking (~4000 chars, labelled with the nearest preceding "Item N."
// section header) → IDF-weighted term-overlap scoring against the question →
// top 6 chunks. Extracted TEXT is cached on disk (data/filing-cache/) and
// never expires — filings are immutable. The chunk index lives in a
// per-process Map (capped at 20 filings) so /filing-context re-selects chunks
// per question cheaply; only the first document fetch is expensive.
//
// SEC etiquette (mandatory): a descriptive User-Agent on every sec.gov /
// data.sec.gov request, and <= ~5 req/s — sequential fetches with small delays.

const SEC_UA = 'Research Platform <admin@researchplatform.dev>';
const SEC_HEADERS = { 'User-Agent': SEC_UA };
const FILING_CACHE_DIR = path.join(REPO_ROOT, 'data', 'filing-cache');
const CHUNK_MAX_CHARS = 4000;
const CHUNKS_RETURNED = 6;
const FILING_INDEX_CAP = 20;

// Rate limiting: gap between successive SEC requests (250ms ≈ 4 req/s max,
// and all our SEC access is sequential anyway).
let _lastSecFetchAt = 0;
async function secFetch(url, timeoutMs = 30_000) {
  const gap = Date.now() - _lastSecFetchAt;
  if (gap < 250) await new Promise((r) => setTimeout(r, 250 - gap));
  _lastSecFetchAt = Date.now();
  return httpClient.fetch(url, { headers: SEC_HEADERS, timeoutMs, span: 'research.sec.fetch' });
}

// --- step 1: ticker → CIK ---------------------------------------------------

const tickerCache = new TtlCache(24 * 60 * 60_000, 5, 'ticker-cik');

async function getTickerMap() {
  return tickerCache.wrap('all', async () => {
    // Disk cache: ~1MB download, avoids re-download per container restart.
    fs.mkdirSync(FILING_CACHE_DIR, { recursive: true });
    const diskPath = path.join(FILING_CACHE_DIR, 'tickers.json');
    try {
      const stat = fs.statSync(diskPath);
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60_000) {
        return JSON.parse(fs.readFileSync(diskPath, 'utf8'));
      }
    } catch { /* no usable disk cache — fetch */ }

    const res = await secFetch('https://www.sec.gov/files/company_tickers.json', 60_000);
    if (!res.ok || !res.json) {
      // Fall back to a stale disk copy if we have one — better than a hard failure.
      try {
        const stale = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
        console.warn('[svc-research] ticker download failed, serving stale disk cache');
        return stale;
      } catch { /* nothing on disk either */ }
      throw new Error(`could not download SEC ticker file (status ${res.status})`);
    }
    // Shape: { "0": {cik_str, ticker, title}, ... } → { TICKER: cik (plain int) }
    const map = {};
    for (const k of Object.keys(res.json)) {
      const e = res.json[k];
      if (e && e.ticker && e.cik_str != null) map[String(e.ticker).toUpperCase()] = Number(e.cik_str);
    }
    try { fs.writeFileSync(diskPath, JSON.stringify(map)); } catch { /* best effort */ }
    return map;
  });
}

// --- steps 2-3: submissions index → latest filing of the requested form -----

async function getLatestFiling(cik, formWanted) {
  const cik10 = String(cik).padStart(10, '0');
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${cik10}.json`);
  if (!res.ok || !res.json) throw new Error(`SEC submissions lookup failed (status ${res.status})`);
  const recent = res.json?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) throw new Error('SEC submissions response missing filings.recent');
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === formWanted && recent.primaryDocument[i]) {
      return {
        accession: recent.accessionNumber[i],
        primaryDocument: recent.primaryDocument[i],
        filedAt: recent.filingDate[i],
      };
    }
  }
  return null;
}

// --- step 4: document fetch + HTML→plain text --------------------------------

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019',
    ldquo: '\u201C', rdquo: '\u201D', bull: '\u2022', deg: '\u00B0', pound: '\u00A3', euro: '\u20AC',
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name.toLowerCase()] ?? m);
}

function htmlToText(html) {
  let t = html;
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  // Paragraph/table structure → double newlines BEFORE stripping remaining tags.
  t = t.replace(/<\/(p|div|tr|table|h[1-6]|li)\s*>/gi, '\n\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/ ?\n ?/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// --- step 5: chunking + scoring ----------------------------------------------

const STOPWORDS = new Set(('a an and are as at be been being but by can could do does for from had has have how '
  + 'i if in into is it its may might must my no not of on or our out over shall should so some such than that '
  + 'the their them then there these they this those to under up was we were what when where which while who '
  + 'whom why will with would you your').split(' '));

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Per-process chunk index: key "<cik>-<accession>" → {chunks, df, N}. Capped LRU-ish at 20. */
const filingIndex = new Map();

function putIndex(key, index) {
  if (filingIndex.has(key)) filingIndex.delete(key);
  filingIndex.set(key, index);
  while (filingIndex.size > FILING_INDEX_CAP) {
    filingIndex.delete(filingIndex.keys().next().value);
  }
}

function buildIndex(text) {
  // Section headers ("Item 1A. Risk Factors" style) with char offsets, so each
  // chunk can be labelled with the nearest preceding header.
  const headers = [];
  const headerRe = /^item\s+(\d+[A-Z]?)\b[.:;\u2013\u2014-]?\s*([^\n]{0,90})$/gim;
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    const tail = m[2].trim();
    if (!tail || /^\d+$/.test(tail)) continue; // TOC lines end in a page number
    headers.push({ at: m.index, label: `Item ${m[1]}. ${tail}`.replace(/[.\s]+$/, '') });
  }
  if (headers.length === 0) headers.push({ at: -1, label: null });

  // Split into paragraphs on blank lines, keeping offsets.
  const paras = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n\n', pos);
    const end = nl === -1 ? text.length : nl;
    const para = text.slice(pos, end).replace(/\n/g, ' ').trim();
    if (para) paras.push({ at: pos, text: para });
    pos = nl === -1 ? text.length : nl + 2;
  }

  // Greedy grouping of consecutive paragraphs into chunks <= CHUNK_MAX_CHARS.
  const chunks = [];
  let cur = null;
  for (const p of paras) {
    if (cur && cur.charCount + p.text.length + 2 > CHUNK_MAX_CHARS) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) {
      let label = null;
      for (const h of headers) {
        if (h.at <= p.at) label = h.label;
        else break;
      }
      cur = { section: label, text: p.text, charCount: p.text.length };
    } else {
      cur.text += '\n\n' + p.text;
      cur.charCount += p.text.length + 2;
    }
  }
  if (cur) chunks.push(cur);

  // Pre-compute per-chunk term frequencies and document frequencies once;
  // per-question scoring then only touches the question's terms (cheap).
  const df = new Map();
  for (const c of chunks) {
    const tf = new Map();
    for (const w of tokenize(c.text)) tf.set(w, (tf.get(w) || 0) + 1);
    c.tf = tf;
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  return { chunks, df, N: chunks.length };
}

function selectChunks(index, question, topN) {
  const qtf = new Map();
  for (const w of tokenize(question)) qtf.set(w, (qtf.get(w) || 0) + 1);
  if (qtf.size === 0) return [];
  // IDF approximation: 1 + ln(N / df) — rare terms within the filing weigh more.
  const idf = new Map();
  for (const w of qtf.keys()) {
    const dfw = index.df.get(w) || 0;
    if (dfw > 0) idf.set(w, 1 + Math.log(index.N / dfw));
  }
  const scored = index.chunks.map((c) => {
    let score = 0;
    for (const [w, q] of qtf) {
      const tf = c.tf.get(w);
      if (!tf) continue;
      score += tf * q * (idf.get(w) || 0);
    }
    // Section-label boost: a question term appearing in the chunk's Item label
    // ("risk" in "Item 1A. Risk Factors") is strong topical evidence — the label
    // is hand-written by the filer. Bonus = 3 × IDF per matched label term.
    if (c.section) {
      const labelTf = new Map();
      for (const w of tokenize(c.section)) labelTf.set(w, (labelTf.get(w) || 0) + 1);
      for (const [w, q] of qtf) {
        if (labelTf.has(w)) score += 3 * q * (idf.get(w) || 1.5);
      }
    }
    return { score, chunk: c };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/** Distinct question terms actually matched anywhere in the given chunks. */
function matchedTermCount(index, question, chunks) {
  const qTerms = new Set(tokenize(question));
  if (qTerms.size === 0) return 0;
  let matched = new Set();
  for (const c of chunks) {
    for (const w of qTerms) {
      if (c.tf.get(w) || (c.section && tokenize(c.section).includes(w))) matched.add(w);
    }
  }
  return matched.size;
}

// ---- HTTP surface ----

const { app, listen, close } = await startService({
  name: 'svc-research',
  port: Number(process.env.PORT || 8006),
  healthDeps: async () => ({
    ok: true,
    financialsCache: financialsCache.size,
    filingsCache: filingsCache.size,
    filingIndex: filingIndex.size,
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

// GET /filing-context/:symbol?q=...&form=10-K|10-Q — retrieval pipeline for the
// filing Q&A feature. svc-llm calls this, then grounds its answer in the chunks.
app.get('/filing-context/:symbol', async (req, reply) => {
  const symbol = String(req.params.symbol || '').trim().toUpperCase();
  const question = String(req.query.q || '').trim();
  const form = String(req.query.form || '10-K').trim().toUpperCase();
  if (!question) return reply.status(400).send({ error: 'q (question) is required' });
  if (!['10-K', '10-Q'].includes(form)) {
    return reply.status(400).send({ error: 'form must be 10-K or 10-Q' });
  }

  try {
    // 1. Ticker → CIK (memory + disk cache).
    const tickers = await getTickerMap();
    const cik = tickers[symbol];
    if (!cik) return reply.status(404).send({ error: `unknown ticker ${symbol}` });
    const cik10 = String(cik).padStart(10, '0');

    // 2. Latest filing of the requested form.
    const filing = await getLatestFiling(cik, form);
    if (!filing) return reply.status(404).send({ error: `no filing found for form ${form}` });

    const key = `${cik}-${filing.accession}`;
    const docUrl = `https://www.sec.gov/Archives/edgar/data/${cik10}/${filing.accession.replace(/-/g, '')}/${filing.primaryDocument}`;

    // 3. Extracted text: disk cache (filings are immutable — no TTL) or fetch.
    let text;
    const cacheFile = path.join(FILING_CACHE_DIR, `${key}.txt`);
    if (fs.existsSync(cacheFile)) {
      text = fs.readFileSync(cacheFile, 'utf8');
    } else {
      const res = await secFetch(docUrl, 90_000);
      if (!res.ok) return reply.status(502).send({ error: `could not fetch filing document (status ${res.status})` });
      text = htmlToText(res.text || '');
      if (text.length < 1000) {
        return reply.status(502).send({ error: 'filing document yielded no usable text' });
      }
      fs.mkdirSync(FILING_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, text);
    }

    // 4. Chunk index in memory; per-question chunk selection is cheap from here.
    let index = filingIndex.get(key);
    if (!index) {
      index = buildIndex(text);
      putIndex(key, index);
    }

    // 5. Score and select the top 6 chunks.
    const top = selectChunks(index, question, CHUNKS_RETURNED);
    // Honest not-found: don't send the LLM excerpts that share essentially no
    // vocabulary with the question. Require at least 2 distinct matched terms
    // (1 for single-term questions) across the selected chunks.
    const minMatched = Math.min(2, new Set(tokenize(question)).size);
    if (top.length === 0 || matchedTermCount(index, question, top.map((s) => s.chunk)) < minMatched) {
      return reply.status(404).send({ error: 'no relevant sections found in the filing for that question' });
    }

    // 6. Response shape.
    return {
      symbol,
      cik,
      form,
      filedAt: filing.filedAt,
      filingUrl: docUrl,
      chunks: top.map((s, i) => ({ n: i + 1, section: s.chunk.section, text: s.chunk.text })),
      question,
    };
  } catch (err) {
    console.error(`[svc-research] filing-context failed for ${symbol}:`, err?.message || err);
    return reply.status(502).send({ error: err?.message || 'filing-context retrieval failed' });
  }
});

await listen();

process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
