#!/usr/bin/env node
/**
 * svc-news (port 8004) — multi-source news aggregation + sentiment scoring per ADR-001.
 * Re-implements the minimal path of src/services/newsDrivers.ts +
 * src/services/sentimentService.ts (those are TS with project imports, so the
 * service carries a plain-JS port) and extends it with multi-source aggregation.
 *
 * ============================================================================
 * SENTIMENT METHODOLOGY (answers the "sentiment/4 is numerology" audit finding)
 * ============================================================================
 * Every number that leaves this service is a documented, reproducible function
 * of real fetched headlines — nothing is hard-coded or divided by magic values.
 *
 * 1. FETCH — per symbol, from every enabled source (NEWS_SOURCES env, default
 *    'yahoo,googlenews,gdelt,stocktwits,edgar'):
 *      - Yahoo Finance search API (yahoo-finance2, kept from the original)
 *      - Google News RSS: https://news.google.com/rss/search?q=<SYM>+stock&hl=en-US&gl=US&ceid=US:en
 *      - GDELT 2.0 doc API: https://api.gdeltproject.org/api/v2/doc/doc?query=<SYM>&mode=artlist&format=json&maxrecords=30
 *      - StockTwits public symbol stream (§7)
 *      - SEC EDGAR submissions-as-events (§8)
 *    Each source has an 8s timeout and fails independently (Promise.allSettled):
 *    a dead source removes only its own headlines, never the others. If every
 *    enabled source errors, the merged cache serves its last-good value
 *    (stale-on-error) and, with no history at all, the service degrades to
 *    empty lists — fabricated sample feeds are NOT counted as news.
 *
 * 2. DEDUPE — syndicated copies of the same story across outlets are collapsed:
 *      normalizeHeadline() lowercases, strips XML entities, outlet suffixes
 *      (" - Reuters" style tails), punctuation and whitespace; two headlines
 *      are duplicates when the normalized strings are equal OR their first 60
 *      normalized characters match. The surviving copy is the one from the
 *      highest-quality source (ties broken by recency), so a Reuters wire copy
 *      outranks an aggregator's repost of the same story.
 *
 * 3. SOURCE-QUALITY WEIGHT q:
 *      1.0 — major wires: Reuters, Bloomberg, AP, Dow Jones, WSJ, FT, CNBC
 *      0.7 — named financial outlets: MarketWatch, Barron's, Investings,
 *            SeekingAlpha, Yahoo
 *      0.4 — everything else (blogs, aggregators, regional press)
 *
 * 4. TIME-DECAY d = 0.5^(ageHours/24): a headline from 24h ago weighs half of
 *    one from this hour; a 3-day-old headline weighs ~1/8. Stale coverage
 *    cannot prop up a score that fresh coverage contradicts.
 *
 * 5. PER-HEADLINE SCORE — the original keyword-lexicon scorer (bullish minus
 *    bearish weighted keywords, normalized by sqrt(hitCount), clamped to
 *    [-1, 1]) runs unchanged on every unique headline, and also yields a
 *    confidence c = min(0.95, 0.45 + 0.12 * hitCount) that shrinks the weight
 *    of low-signal headlines.
 *
 * 6. AGGREGATE — sentimentScore = 100 * Σ(s_i × w_i) / Σ(w_i), clamped to
 *    [-100, 100], where w_i = q_i × d_i × c_i. This replaces the old
 *    plain confidence-weighted mean: identical headlines no longer count N
 *    times, stale copy fades, and wire-grade sources dominate aggregator
 *    noise. bullish/bearish/newsItems keep their original shapes.
 *
 * 7. SOCIAL STREAM (StockTwits) — the public per-symbol message stream
 *    (https://api.stocktwits.com/api/2/streams/symbol/<SYM>.json; free, no
 *    key; one call per symbol per 10min cache window; non-2xx — 404 unknown
 *    symbol, 429 rate limit — and parse failures degrade to an empty list).
 *    Each message becomes a headline item: body is the headline, source
 *    'StockTwits', publishedAt from the message timestamp. Sentiment comes
 *    from the author's own Bullish/Bearish tag when present (fixed score
 *    ±0.6 at confidence 0.6 — a human tag carries no magnitude); untagged
 *    messages run through the same lexicon scorer as every other headline.
 *    SOCIAL WEIGHT CAP: the quality weight of every StockTwits item is pinned
 *    to 0.3 regardless of the outlet rules — crowd chatter is noise at
 *    swing/long horizons, so it can color the short-term aggregate but can
 *    never dominate wire-grade coverage.
 *
 * 8. REGULATORY EVENTS (SEC EDGAR) — filings are treated as events, not news.
 *    The symbol's CIK is resolved via the cached map at
 *    data/filing-cache/tickers.json when present, else SEC's
 *    company_tickers.json (fetched once, cached 24h in memory). Every SEC
 *    request carries the mandatory User-Agent 'Research Platform
 *    admin@researchplatform.dev' and stays inside the ≤10 req/s etiquette
 *    (one submissions call per symbol per cache window). Filings from the
 *    last 14 days with form 8-K, 10-Q, 10-K, SC 13D/G (incl. /A) or Form 4
 *    each become an event item: headline
 *    'SEC filing: <FORM> filed <DATE> — <description>' (primaryDocDescription,
 *    else the form-type description), source 'SEC EDGAR', quality weight 1.0
 *    (regulatory events are high-signal, so their confidence is pinned to 1.0
 *    as well), sentiment neutral 0 unless the existing lexicon scorer scores
 *    the description, and a filing:true flag on the newsItem. They flow
 *    through the same dedupe / time-decay pipeline as ordinary headlines.
 */
import { startService, loadEnvLocal, TtlCache } from '../shared/lib.mjs';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnvLocal();
const { default: YahooFinance } = await import('yahoo-finance2');
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// newsCache caches the MERGED per-symbol analysis (all sources → dedupe →
// score → aggregate) for 10min; both /drivers and /sentiment read through it,
// so there is exactly one fetch cycle per symbol per TTL window.
const newsCache = new TtlCache(10 * 60_000, 500, 'news'); // 10min — news cycles in minutes

// ---- Source toggle: NEWS_SOURCES env (default 'yahoo,googlenews,gdelt,stocktwits,edgar') ----
const NEWS_SOURCES = String(process.env.NEWS_SOURCES || 'yahoo,googlenews,gdelt,stocktwits,edgar')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ---- Financial keyword lexicon with weighted polarity (from sentimentService.ts) ----
const bullishKeywords = [
  { word: 'beat', weight: 0.9 }, { word: 'beats', weight: 0.9 }, { word: 'surpassed', weight: 0.8 },
  { word: 'outperform', weight: 0.8 }, { word: 'upgrade', weight: 0.85 }, { word: 'upgraded', weight: 0.85 },
  { word: 'record revenue', weight: 0.95 }, { word: 'record profit', weight: 0.95 }, { word: 'bull', weight: 0.7 },
  { word: 'bullish', weight: 0.8 }, { word: 'breakout', weight: 0.75 }, { word: 'surge', weight: 0.75 },
  { word: 'soar', weight: 0.8 }, { word: 'soars', weight: 0.8 }, { word: 'growth', weight: 0.6 },
  { word: 'partnership', weight: 0.7 }, { word: 'buyback', weight: 0.8 }, { word: 'dividend hike', weight: 0.75 },
  { word: 'innovation', weight: 0.6 }, { word: 'ai momentum', weight: 0.85 }, { word: 'expansion', weight: 0.65 },
  { word: 'strong demand', weight: 0.85 }, { word: 'guidance raised', weight: 0.95 }, { word: 'raised target', weight: 0.8 },
  { word: 'undervalued', weight: 0.7 }, { word: 'overweight', weight: 0.75 },
];
const bearishKeywords = [
  { word: 'miss', weight: -0.9 }, { word: 'misses', weight: -0.9 }, { word: 'downgrade', weight: -0.85 },
  { word: 'downgraded', weight: -0.85 }, { word: 'slump', weight: -0.8 }, { word: 'plunge', weight: -0.85 },
  { word: 'drop', weight: -0.6 }, { word: 'fell', weight: -0.5 }, { word: 'cuts guidance', weight: -0.95 },
  { word: 'guidance lowered', weight: -0.95 }, { word: 'investigation', weight: -0.85 }, { word: 'lawsuit', weight: -0.75 },
  { word: 'probe', weight: -0.8 }, { word: 'warning', weight: -0.8 }, { word: 'inflation', weight: -0.5 },
  { word: 'layoffs', weight: -0.7 }, { word: 'headwinds', weight: -0.65 }, { word: 'bearish', weight: -0.8 },
  { word: 'underperform', weight: -0.8 }, { word: 'selloff', weight: -0.85 }, { word: 'fraud', weight: -1.0 },
  { word: 'debt burden', weight: -0.75 }, { word: 'tariff', weight: -0.6 }, { word: 'recession', weight: -0.7 },
];

function scoreArticleText(title, summary = '') {
  const fullText = `${title} ${summary}`.toLowerCase();
  let score = 0;
  let hitCount = 0;
  for (const kw of bullishKeywords) if (fullText.includes(kw.word)) { score += kw.weight; hitCount++; }
  for (const kw of bearishKeywords) if (fullText.includes(kw.word)) { score += kw.weight; hitCount++; }

  const clampedScore = Math.max(-1, Math.min(1, hitCount > 0 ? score / Math.max(1, Math.sqrt(hitCount)) : 0));
  const confidence = Math.min(0.95, 0.45 + hitCount * 0.12);

  let sentiment = 'NEUTRAL';
  if (clampedScore > 0.15) sentiment = 'BULLISH';
  else if (clampedScore < -0.15) sentiment = 'BEARISH';

  // Categorize catalyst
  let category = 'GENERAL';
  let catalystSummary = 'General market commentary and news flow.';
  if (fullText.includes('earnings') || fullText.includes('revenue') || fullText.includes('profit') || fullText.includes('eps')) {
    category = 'EARNINGS'; catalystSummary = 'Quarterly financial report results and earnings revisions.';
  } else if (fullText.includes('product') || fullText.includes('ai') || fullText.includes('chip') || fullText.includes('launch') || fullText.includes('software')) {
    category = 'PRODUCT'; catalystSummary = 'New product roadmap, technology innovations, or commercial rollouts.';
  } else if (fullText.includes('fda') || fullText.includes('antitrust') || fullText.includes('investigation') || fullText.includes('regulat') || fullText.includes('sec')) {
    category = 'REGULATORY'; catalystSummary = 'Regulatory compliance scrutiny, legal proceedings, or government policy.';
  } else if (fullText.includes('inflation') || fullText.includes('fed') || fullText.includes('interest rate') || fullText.includes('treasury')) {
    category = 'MACRO'; catalystSummary = 'Macroeconomic monetary policy and interest rate environment.';
  } else if (fullText.includes('merger') || fullText.includes('acquisition') || fullText.includes('partner') || fullText.includes('buyout')) {
    category = 'M&A'; catalystSummary = 'Strategic merger, acquisition, or enterprise partnership expansion.';
  } else if (fullText.includes('upgrade') || fullText.includes('downgrade') || fullText.includes('target') || fullText.includes('analyst')) {
    category = 'ANALYST_RATING'; catalystSummary = 'Wall Street analyst price target revision or rating adjustment.';
  }

  return { sentiment, score: Number(clampedScore.toFixed(2)), confidence: Number(confidence.toFixed(2)), category, catalystSummary };
}

// ---- Source-quality weights (see methodology block above) ----
const MAJOR_WIRES = ['reuters', 'bloomberg', 'associated press', 'apnews', 'ap.org', 'dow jones', 'wsj', 'wall street journal', 'financial times', 'cnbc'];
const NAMED_OUTLETS = ['marketwatch', 'barron', 'investings', 'seekingalpha', 'seeking alpha', 'yahoo'];

/** q in {1.0, 0.7, 0.4} per methodology section 3. */
export function sourceQualityWeight(publisher) {
  const name = String(publisher || '').toLowerCase().replace(/^www\./, '');
  if (MAJOR_WIRES.some((k) => name.includes(k))) return 1.0;
  if (NAMED_OUTLETS.some((k) => name.includes(k))) return 0.7;
  // Short tokens ('ap', 'ft') only match as standalone words, never inside 'apple'/'shift'.
  if (/(^|[\s./])ap([\s./]|$)/.test(name) || /(^|[\s./])ft([\s./]|$)/.test(name)) return 1.0;
  return 0.4;
}

/** d = 0.5^(ageHours/24) per methodology section 4. */
export function timeDecayWeight(publishTimeMs) {
  const ageHours = Math.max(0, (Date.now() - (publishTimeMs || Date.now())) / 3_600_000);
  return Math.pow(0.5, ageHours / 24);
}

// ---- Headline normalization + dedupe (methodology section 2) ----
const OUTLET_SUFFIX_TOKENS = [...MAJOR_WIRES, ...NAMED_OUTLETS, 'cnbc', 'bbc', 'cnn', 'nytimes', 'new york times', 'wsj.com', 'bloomberg.com', 'benzinga', 'investing.com', 'barrons', 'fool', 'motley fool', 'zacks', 'tipranks', 'insider', 'business insider', 'financial post', 'the globe and mail', 'techcrunch', 'streetinsider', 'barchart', 'medium', 'substack', 'tradingview', 'simply wall st', 'quartr', 'stocktwits'];

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/"/g, '"').replace(/'/g, "'").replace(/</g, '<')
    .replace(/>/g, '>').replace(/&nbsp;/g, ' ').replace(/&/g, '&');
}

/** Lowercase, strip outlet suffix tails, punctuation and extra whitespace. */
export function normalizeHeadline(title) {
  let t = decodeEntities(String(title || '')).toLowerCase().trim();
  // Google News appends " - Outlet": drop the tail when it names a known outlet.
  const tailMatch = t.match(/\s+[-–—|·]\s+([^-–—|·]+)$/);
  if (tailMatch) {
    const tail = tailMatch[1].trim();
    if (OUTLET_SUFFIX_TOKENS.some((k) => tail.includes(k))) t = t.slice(0, tailMatch.index).trim();
  }
  return t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Collapse syndicated copies: duplicate when normalized headlines are equal OR
 * their first 60 normalized chars match. The kept copy is the one from the
 * highest-quality source (ties broken by most recent publish time).
 */
export function dedupeArticles(items) {
  const ranked = [...items].sort((a, b) =>
    (b._quality - a._quality) || ((b.providerPublishTime || 0) - (a.providerPublishTime || 0)));
  const byKey = new Map(); // first-60 key -> kept item
  for (const it of ranked) {
    const norm = normalizeHeadline(it.title);
    if (!norm || norm.length < 8) continue;
    const key = norm.slice(0, 60);
    const kept = byKey.get(key);
    if (kept) {
      // Duplicate: exact-equal or near-match (same first 60 normalized chars).
      kept._dupes = (kept._dupes || 0) + 1;
      if (!kept._syndicatedBy) kept._syndicatedBy = [];
      kept._syndicatedBy.push(it.publisher);
      continue;
    }
    byKey.set(key, it);
  }
  return [...byKey.values()];
}

// ---- TLS note ----
// The Docker VM does not trust the host's TLS-interception CA (the local
// Cloudflare Gateway decrypts news.google.com; the CA lives in the host
// keychain, not in the node:24 image), so plain fetch() fails there with
// "self-signed certificate in certificate chain". newsFetch() trusts the
// gateway CA explicitly — loaded from gateway-ca.pem next to this file
// (override: NEWS_EXTRA_CA_FILE) — only when present; verification is never
// disabled. Yahoo keeps yahoo-finance2 and GDELT chains normally, so they are
// unaffected either way.
let extraCa = null;
try {
  const caPath = process.env.NEWS_EXTRA_CA_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'gateway-ca.pem');
  if (fs.existsSync(caPath)) extraCa = fs.readFileSync(caPath, 'utf8');
} catch { /* no extra CA — standard verification only */ }

/**
 * Single-attempt GET with an absolute timeout and simple 3xx follow.
 * Used for the two raw-HTTP sources: httpClient's 2-retry policy is
 * counterproductive here (GDELT rate-limits to 1 req/5s and answers slowly,
 * so retries only burn the gateway's 25s proxy budget) and it cannot carry
 * the extra CA that news.google.com needs inside Docker.
 * Mirrors the httpClient response contract: {status, ok, text}, non-2xx does not throw.
 */
function newsFetch(url, { timeoutMs = 8000, depth = 0, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      // Extra CA is ADDED to the bundled Mozilla roots (not a replacement), so
      // normally-chained hosts like GDELT still verify.
      ca: extraCa ? [...tls.rootCertificates, extraCa] : undefined,
      headers: { 'user-agent': 'ResearchPlatform/1.0 (news aggregator)', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && depth < 2) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(newsFetch(next, { timeoutMs, depth: depth + 1, headers }));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ---- Source fetchers — each returns [{title, publisher, link, providerPublishTime, summary, sourceTag}] ----

/** (a) Yahoo Finance news via yahoo-finance2 search (original source, kept). */
async function fetchYahooNews(symbol) {
  const searchRes = await yf.search(symbol, { newsCount: 12 });
  return (searchRes.news || []).map((n) => ({
    title: n.title,
    publisher: n.publisher || 'Yahoo Finance',
    link: n.link,
    providerPublishTime: n.providerPublishTime ? new Date(n.providerPublishTime).getTime() : Date.now(),
    summary: n.description || undefined,
    sourceTag: 'yahoo',
  }));
}

/** (b) Google News RSS — parsed with regex, no new deps. */
async function fetchGoogleNewsRss(symbol) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${symbol} stock`)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await newsFetch(url, { timeoutMs: 8000 });
  if (!res.ok || !res.text) return [];
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(res.text)) !== null && items.length < 20) {
    const block = m[1];
    const pick = (tag) => {
      const tm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return tm ? decodeEntities(tm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
    };
    const title = pick('title');
    if (!title) continue;
    const sourceName = (() => {
      const sm = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      return sm ? decodeEntities(sm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
    })();
    const pubDate = pick('pubDate');
    const ts = pubDate ? Date.parse(pubDate) : NaN;
    // Strip the " - Outlet" suffix Google News appends when the source tag names it.
    const cleanTitle = sourceName && title.toLowerCase().endsWith(` - ${sourceName.toLowerCase()}`)
      ? title.slice(0, title.length - sourceName.length - 3) : title;
    items.push({
      title: cleanTitle,
      publisher: sourceName || 'Google News',
      link: pick('link') || undefined,
      providerPublishTime: Number.isFinite(ts) ? ts : Date.now(),
      summary: undefined,
      sourceTag: 'googlenews',
    });
  }
  return items;
}

/** (c) GDELT 2.0 doc API — free, no key. Publisher = article domain. */
async function fetchGdeltNews(symbol) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(symbol)}&mode=artlist&format=json&maxrecords=30`;
  // GDELT's measured response floor is ~12s and it rate-limits to 1 req/5s,
  // so one 15s attempt (still inside the gateway's 25s proxy budget when run
  // in parallel with the other sources); a 429 counts as an empty result.
  const res = await newsFetch(url, { timeoutMs: 15_000 });
  if (!res.ok || !res.text) return [];
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch { return []; }
  const articles = Array.isArray(parsed?.articles) ? parsed.articles : [];
  return articles.map((a) => {
    // GDELT seendate format: 20261027T120000Z
    const sm = String(a.seendate || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    const ts = sm ? Date.parse(`${sm[1]}-${sm[2]}-${sm[3]}T${sm[4]}:${sm[5]}:${sm[6]}Z`) : NaN;
    return {
      title: a.title || '',
      publisher: a.domain || 'GDELT',
      link: a.url || undefined,
      providerPublishTime: Number.isFinite(ts) ? ts : Date.now(),
      summary: undefined,
      sourceTag: 'gdelt',
    };
  }).filter((a) => a.title);
}

/**
 * (d) StockTwits public symbol stream — free, no key. Each message becomes a
 * headline item whose quality weight is capped at 0.3 (§7). Non-2xx (404
 * unknown symbol, 429 rate limit) and parse failures degrade to an empty list.
 */
const SOCIAL_QUALITY_CAP = 0.3; // §7 — social is noise at swing/long horizons
async function fetchStockTwits(symbol) {
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`;
  // StockTwits fronts the API with a probabilistic Cloudflare bot challenge:
  // a request can come back 403 "Just a moment…" while an immediate retry on
  // the same warm connection passes (observed live). One single retry after a
  // short backoff — anything more would hammer a rate-limited free endpoint.
  let res = await newsFetch(url, { timeoutMs: 8000, headers: { accept: 'application/json' } });
  if (res.status === 403) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await newsFetch(url, { timeoutMs: 8000, headers: { accept: 'application/json' } });
  }
  if (!res.ok || !res.text) return [];
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch { return []; }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  return messages.slice(0, 30).map((m) => {
    // StockTwits bodies carry XML entities (&#39; …) — decode for display;
    // dedupe already normalizes them, but the served headline should be clean.
    const body = decodeEntities(String(m.body || '')).trim();
    if (!body) return null;
    const ts = Date.parse(m.created_at || '');
    const tag = m.sentiment && m.sentiment.basic; // 'Bullish' | 'Bearish' | undefined
    const item = {
      title: body,
      publisher: 'StockTwits',
      link: m.id && m.user?.username ? `https://stocktwits.com/${m.user.username}/message/${m.id}` : undefined,
      providerPublishTime: Number.isFinite(ts) ? ts : Date.now(),
      summary: undefined,
      sourceTag: 'stocktwits',
      _social: true,
      _qualityOverride: SOCIAL_QUALITY_CAP,
    };
    if (tag === 'Bullish' || tag === 'Bearish') {
      // Human tag: no magnitude — fixed ±0.6 at confidence 0.6 (§7). Catalyst
      // categorization still comes from the body so buckets stay consistent.
      const cats = scoreArticleText(body, '');
      item._sentimentOverride = {
        sentiment: tag === 'Bullish' ? 'BULLISH' : 'BEARISH',
        score: tag === 'Bullish' ? 0.6 : -0.6,
        confidence: 0.6,
        category: cats.category,
        catalystSummary: cats.catalystSummary,
      };
    }
    return item;
  }).filter(Boolean);
}

/**
 * (e) SEC EDGAR filings-as-events (§8). CIK resolution prefers the cached
 * data/filing-cache/tickers.json map (owned by svc-research, read-only here);
 * when that file is not present (e.g. not mounted into this container) SEC's
 * company_tickers.json is fetched once and cached in memory for 24h. Every
 * SEC request carries the mandatory User-Agent and stays inside the ≤10 req/s
 * etiquette — one submissions call per symbol per 10min cache window.
 */
const SEC_USER_AGENT = 'Research Platform admin@researchplatform.dev';
const EDGAR_EVENT_FORMS = new Set(['8-K', '10-Q', '10-K', 'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', '4']);
const EDGAR_EVENT_WINDOW_MS = 14 * 24 * 3_600_000; // filings from the last 14 days
const EDGAR_MAX_ITEMS = 15;
const EDGAR_FORM_DESCRIPTIONS = {
  '8-K': 'Current report',
  '10-Q': 'Quarterly report',
  '10-K': 'Annual report',
  '4': 'Statement of changes in beneficial ownership (insider Form 4)',
  'SC 13D': 'Beneficial ownership report (Schedule 13D)',
  'SC 13G': 'Beneficial ownership report (Schedule 13G)',
};
function edgarFormDescription(form) {
  const amended = form.endsWith('/A');
  const base = amended ? form.slice(0, -2) : form;
  return `${EDGAR_FORM_DESCRIPTIONS[base] || base}${amended ? ' (amended)' : ''}`;
}

const cachedTickerMapPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/filing-cache/tickers.json');
let cachedTickerMap = null;
try {
  if (fs.existsSync(cachedTickerMapPath)) cachedTickerMap = JSON.parse(fs.readFileSync(cachedTickerMapPath, 'utf8'));
} catch { cachedTickerMap = null; } // unreadable cache — fall through to SEC's map

let companyTickersMap = null;
let companyTickersAt = 0;
const COMPANY_TICKERS_TTL = 24 * 3_600_000;

async function loadCompanyTickersMap() {
  if (companyTickersMap && Date.now() - companyTickersAt < COMPANY_TICKERS_TTL) return companyTickersMap;
  const res = await newsFetch('https://www.sec.gov/files/company_tickers.json', {
    timeoutMs: 15_000,
    headers: { 'user-agent': SEC_USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok || !res.text) throw new Error(`company_tickers.json HTTP ${res.status}`);
  const parsed = JSON.parse(res.text);
  // SEC's file is a top-level index map ({'0':{cik_str,ticker,title},…});
  // tolerate a {data:[…]} wrapper in case the shape ever changes.
  const rows = (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object')
    ? Object.values(parsed.data)
    : Object.values(parsed || {});
  const map = new Map();
  for (const row of rows) {
    if (row && row.ticker && row.cik_str) map.set(String(row.ticker).toUpperCase(), String(row.cik_str));
  }
  companyTickersMap = map;
  companyTickersAt = Date.now();
  return map;
}

/** CIK (10-digit zero-padded) for a symbol, or null when unknown. */
async function resolveCik(symbol) {
  const upper = String(symbol).trim().toUpperCase();
  if (cachedTickerMap && cachedTickerMap[upper]) return String(cachedTickerMap[upper]).padStart(10, '0');
  try {
    const map = await loadCompanyTickersMap();
    return map.has(upper) ? String(map.get(upper)).padStart(10, '0') : null;
  } catch (err) {
    console.warn(`[svc-news] EDGAR CIK lookup failed for ${upper}:`, err?.message || err);
    return null;
  }
}

async function fetchEdgarFilings(symbol) {
  const cik = await resolveCik(symbol);
  if (!cik) return []; // unknown symbol — nothing to surface, never an error
  const res = await newsFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    timeoutMs: 10_000,
    headers: { 'user-agent': SEC_USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok || !res.text) return [];
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch { return []; }
  const recent = parsed?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) return [];
  // Date-string comparison so the whole day 14 days back is inside the window.
  const cutoffDate = new Date(Date.now() - EDGAR_EVENT_WINDOW_MS).toISOString().slice(0, 10);
  const cikInt = String(Number(cik));
  const items = [];
  // recent[] is newest-first, so the first EDGAR_MAX_ITEMS hits are the freshest.
  for (let i = 0; i < recent.form.length && items.length < EDGAR_MAX_ITEMS; i++) {
    const form = String(recent.form[i] || '');
    if (!EDGAR_EVENT_FORMS.has(form)) continue;
    const filingDate = String(recent.filingDate?.[i] || '');
    const filedTs = Date.parse(filingDate);
    if (!Number.isFinite(filedTs) || filingDate < cutoffDate) continue;
    const acceptedTs = Date.parse(String(recent.acceptanceDateTime?.[i] || ''));
    const accession = String(recent.accessionNumber?.[i] || '').replace(/-/g, '');
    const primaryDoc = String(recent.primaryDocument?.[i] || '');
    const desc = String(recent.primaryDocDescription?.[i] || '').trim() || edgarFormDescription(form);
    const headline = `SEC filing: ${form} filed ${filingDate} — ${desc}`;
    // §8: sentiment neutral 0 unless the existing scorer scores the
    // description; the event itself is high-signal, so weight 1.0 is pinned
    // via quality AND confidence overrides regardless of lexicon hits.
    const lex = scoreArticleText(headline, desc);
    items.push({
      title: headline,
      publisher: 'SEC EDGAR',
      link: accession && primaryDoc ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession}/${primaryDoc}` : undefined,
      providerPublishTime: Number.isFinite(acceptedTs) ? acceptedTs : filedTs,
      summary: undefined,
      sourceTag: 'edgar',
      _filing: true,
      _qualityOverride: 1.0,
      _sentimentOverride: { ...lex, confidence: 1.0 },
    });
  }
  return items;
}

const SOURCE_FETCHERS = {
  yahoo: fetchYahooNews,
  googlenews: fetchGoogleNewsRss,
  gdelt: fetchGdeltNews,
  stocktwits: fetchStockTwits,
  edgar: fetchEdgarFilings,
};

// Exported for unit/smoke testing of the §7/§8 mapping and weight rules.
export { fetchStockTwits, fetchEdgarFilings };

/**
 * Fetch every enabled source independently (per-source failure is isolated),
 * dedupe across sources, score each unique headline and aggregate.
 * Throws only when ALL enabled sources errored (lets TtlCache serve stale).
 */
export async function buildMergedAnalysis(symbol) {
  const enabled = NEWS_SOURCES.filter((s) => typeof SOURCE_FETCHERS[s] === 'function');
  const unknown = NEWS_SOURCES.filter((s) => typeof SOURCE_FETCHERS[s] !== 'function');
  if (unknown.length) console.warn(`[svc-news] unknown sources in NEWS_SOURCES ignored: ${unknown.join(', ')}`);

  const settled = await Promise.allSettled(enabled.map((tag) => SOURCE_FETCHERS[tag](symbol)));
  const raw = [];
  const sourceStatus = {};
  let anyError = false;
  settled.forEach((r, i) => {
    const tag = enabled[i];
    if (r.status === 'fulfilled') {
      sourceStatus[tag] = { ok: true, count: r.value.length };
      for (const item of r.value) {
        raw.push({
          ...item,
          // §7/§8: social + regulatory sources pin their own quality weight;
          // every other source keeps the outlet-rules weight.
          _quality: typeof item._qualityOverride === 'number'
            ? item._qualityOverride
            : sourceQualityWeight(item.publisher),
        });
      }
    } else {
      anyError = true;
      sourceStatus[tag] = { ok: false, error: String(r.reason?.message || r.reason).slice(0, 200) };
      console.warn(`[svc-news] source '${tag}' failed for ${symbol}:`, r.reason?.message || r.reason);
    }
  });
  if (enabled.length === 0) { anyError = true; console.warn('[svc-news] no valid sources enabled in NEWS_SOURCES'); }

  const unique = dedupeArticles(raw);
  if (unique.length === 0 && anyError) throw new Error(`all news sources unavailable for ${symbol}`);

  // Score + weight each unique headline: w = quality × timeDecay × confidence.
  // §7/§8: sources that carry an explicit sentiment (StockTwits author tags)
  // or a pinned weight (SEC EDGAR events) supply _sentimentOverride instead
  // of re-running the lexicon; everything else is scored exactly as before.
  const scored = unique.map((item) => {
    const s = item._sentimentOverride || scoreArticleText(item.title, item.summary || '');
    const decay = timeDecayWeight(item.providerPublishTime);
    return { ...item, _sentiment: s, _decay: decay, _weight: item._quality * decay * s.confidence };
  });

  const totalWeight = scored.reduce((acc, a) => acc + a._weight, 0);
  const weightedSum = scored.reduce((acc, a) => acc + a._sentiment.score * a._weight, 0);
  const overallScore = Math.max(-100, Math.min(100, totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0));

  return { articles: scored, overallScore, sourceStatus, enabledSources: enabled };
}

/** The single cached fetch+analyze pass — /drivers and /sentiment share it. */
function getAnalysis(symbol) {
  return newsCache.wrap(symbol, () => buildMergedAnalysis(symbol));
}

/** Pure mapping from a merged analysis to the /sentiment response shape. */
function analyzeFromMerged(cleanSymbol, merged) {
  const articles = merged.articles.map((item, idx) => {
    const s = item._sentiment;
    return {
      id: `news-${cleanSymbol}-${idx}-${Date.now()}`,
      title: item.title,
      publisher: item.publisher || 'Financial Wire',
      link: item.link,
      providerPublishTime: item.providerPublishTime || Date.now(),
      summary: item.summary,
      relatedTickers: [cleanSymbol],
      sentiment: s.sentiment,
      sentimentScore: s.score,
      confidence: s.confidence,
      catalystCategory: s.category,
      catalystSummary: s.catalystSummary,
    };
  });

  const totalCount = articles.length || 1;
  const bullishCount = articles.filter((a) => a.sentiment === 'BULLISH').length;
  const bearishCount = articles.filter((a) => a.sentiment === 'BEARISH').length;
  const neutralCount = articles.filter((a) => a.sentiment === 'NEUTRAL').length;

  const overallScore = merged.overallScore ?? 0;

  let sentimentLabel = 'NEUTRAL';
  if (overallScore >= 45) sentimentLabel = 'STRONGLY_BULLISH';
  else if (overallScore >= 15) sentimentLabel = 'BULLISH';
  else if (overallScore <= -45) sentimentLabel = 'STRONGLY_BEARISH';
  else if (overallScore <= -15) sentimentLabel = 'BEARISH';

  return {
    symbol: cleanSymbol,
    overallScore,
    sentimentLabel,
    bullishPercentage: Math.round((bullishCount / totalCount) * 100),
    bearishPercentage: Math.round((bearishCount / totalCount) * 100),
    neutralPercentage: Math.round((neutralCount / totalCount) * 100),
    articlesAnalyzedCount: articles.length,
    news: articles,
  };
}

/** Port of sentimentService.analyzeStockSentiment — response shape unchanged. */
async function analyzeStockSentiment(symbol) {
  const cleanSymbol = String(symbol).trim().toUpperCase();
  return analyzeFromMerged(cleanSymbol, await getAnalysis(cleanSymbol));
}

const numToWords = (n) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
const trimTitle = (t, max = 90) => {
  const clean = t.trim().replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
};

/** Port of newsDrivers.getNewsDrivers — never throws; degrades to empty lists.
 *  The expensive part (multi-source fetch + dedupe + scoring) is already cached
 *  10min per symbol via getAnalysis (the same single wrap analyzeStockSentiment
 *  uses — exactly one in-flight fetch per key), so this mapping is cheap and
 *  deterministic and is intentionally NOT wrapped again. */
async function getNewsDrivers(symbol) {
  const clean = String(symbol).trim().toUpperCase();
  try {
    const merged = await getAnalysis(clean);
    const sentiment = analyzeFromMerged(clean, merged);

    const newsItems = merged.articles.map((item) => {
      const s = item._sentiment;
      return {
        title: item.title,
        source: item.publisher || 'Financial Wire',
        url: item.link || undefined,
        publishedAt: item.providerPublishTime,
        sentiment: s.sentiment === 'BULLISH' ? 'bullish' : s.sentiment === 'BEARISH' ? 'bearish' : 'neutral',
        score: s.score,
        // §7/§8 flags — added only on social/regulatory items; plain news
        // items keep their original shape byte-for-byte.
        ...(item._filing ? { filing: true } : {}),
        ...(item._social ? { social: true } : {}),
      };
    });

    const total = newsItems.length;
    const bullishCount = newsItems.filter((n) => n.sentiment === 'bullish').length;
    const bearishCount = newsItems.filter((n) => n.sentiment === 'bearish').length;
    const neutralCount = total - bullishCount - bearishCount;
    const score = sentiment.overallScore ?? 0;

    const bullish = [];
    const bearish = [];

    if (total === 0) {
      bullish.push('No recent headlines available — news sentiment is not factored into this verdict.');
    } else {
      if (bullishCount > 0) {
        const topBull = newsItems.filter((n) => n.sentiment === 'bullish').sort((a, b) => b.score - a.score)[0];
        bullish.push(`${numToWords(bullishCount).replace(/^one$/, 'One')} of the last ${numToWords(total)} headline${total > 1 ? 's' : ''} ${bullishCount === 1 ? 'was' : 'were'} positive — the strongest reads "${trimTitle(topBull.title)}".`);
      }
      if (neutralCount > 0 && neutralCount >= bullishCount && neutralCount >= bearishCount) {
        bullish.push(`Most coverage (${neutralCount} of ${numToWords(total)} stories) is neutral, so news flow is not adding strong pressure either way.`);
      }
      if (score >= 20) bullish.push(`Overall news mood is clearly positive (score ${score}/100) — headlines lean toward growth and momentum.`);
      else if (score >= 5) bullish.push(`News flow tilts mildly positive (score ${score}/100).`);
      if (bearishCount > 0) {
        const topBear = newsItems.filter((n) => n.sentiment === 'bearish').sort((a, b) => a.score - b.score)[0];
        bearish.push(`${numToWords(bearishCount).replace(/^one$/, 'One')} of the last ${numToWords(total)} headline${total > 1 ? 's' : ''} ${bearishCount === 1 ? 'was' : 'were'} negative — the most concerning reads "${trimTitle(topBear.title)}".`);
      }
      if (score <= -20) bearish.push(`Overall news mood is clearly negative (score ${score}/100) — watch for continued downside pressure.`);
      else if (score <= -5) bearish.push(`News flow tilts mildly negative (score ${score}/100).`);
    }

    return { newsItems, bullish, bearish, sentimentScore: score };
  } catch (err) {
    console.warn(`[svc-news] sentiment unavailable for ${clean}:`, err?.message || err);
    return { newsItems: [], bullish: [], bearish: [], sentimentScore: 0 };
  }
}

// ---- HTTP surface ----
const { app, listen, close } = await startService({
  name: 'svc-news',
  port: Number(process.env.PORT || 8004),
  healthDeps: async () => ({ ok: true, newsCache: newsCache.size, sources: NEWS_SOURCES.join(',') }),
});

app.get('/drivers/:symbol', async (req, reply) => {
  try {
    const drivers = await getNewsDrivers(req.params.symbol);
    return { symbol: String(req.params.symbol).trim().toUpperCase(), ...drivers };
  } catch (err) {
    return reply.status(502).send({ error: err.message });
  }
});

app.get('/sentiment/:symbol', async (req, reply) => {
  try {
    return await analyzeStockSentiment(req.params.symbol);
  } catch (err) {
    return reply.status(502).send({ error: err.message });
  }
});

await listen();
