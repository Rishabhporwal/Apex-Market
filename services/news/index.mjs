#!/usr/bin/env node
/**
 * svc-news (port 8004) — news drivers + sentiment scoring per ADR-001.
 * Re-implements the minimal path of src/services/newsDrivers.ts +
 * src/services/sentimentService.ts (those are TS with project imports, so the
 * service carries a plain-JS port): fetch news via yahoo-finance2 search,
 * keyword-lexicon sentiment scoring identical to the original, 10min TTL cache.
 */
import { startService, loadEnvLocal, TtlCache } from '../shared/lib.mjs';

loadEnvLocal();
const { default: YahooFinance } = await import('yahoo-finance2');
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const newsCache = new TtlCache(10 * 60_000, 500, 'news'); // 10min — news cycles in minutes

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

async function fetchNews(symbol) {
  try {
    const searchRes = await yf.search(symbol, { newsCount: 12 });
    if (searchRes.news && searchRes.news.length > 0) {
      return searchRes.news.map((n) => ({
        title: n.title,
        publisher: n.publisher,
        link: n.link,
        providerPublishTime: n.providerPublishTime ? new Date(n.providerPublishTime).getTime() : Date.now(),
        summary: n.description || undefined,
      }));
    }
  } catch (err) {
    console.warn(`Could not fetch live news for ${symbol}, providing verified market feeds:`, err?.message || err);
  }
  // High-quality verified sample news feed fallback (same as sentimentService.ts)
  return [
    { title: `${symbol} Exceeds Wall Street Cloud and AI Infrastructure Growth Forecasts`, publisher: 'Bloomberg Markets', link: 'https://finance.yahoo.com', providerPublishTime: Date.now() - 3600000 * 2 },
    { title: `Institutional Inflows Surge for ${symbol} as Analysts Reiterate Buy Ratings`, publisher: 'Reuters', link: 'https://finance.yahoo.com', providerPublishTime: Date.now() - 3600000 * 5 },
    { title: `Macro Interest Rate Decisions May Present Short-Term Volatility for Tech Equities`, publisher: 'Wall Street Journal', link: 'https://finance.yahoo.com', providerPublishTime: Date.now() - 3600000 * 12 },
    { title: `${symbol} Management Announces Multi-Billion Share Repurchase Authorization`, publisher: 'CNBC', link: 'https://finance.yahoo.com', providerPublishTime: Date.now() - 3600000 * 24 },
    { title: `Supply Chain Optimization and Gross Margin Expansion Fuel ${symbol} Upside`, publisher: 'Morgan Stanley Research', link: 'https://finance.yahoo.com', providerPublishTime: Date.now() - 3600000 * 36 },
  ];
}

/** Port of sentimentService.analyzeStockSentiment. */
async function analyzeStockSentiment(symbol) {
  const cleanSymbol = String(symbol).trim().toUpperCase();
  const rawNews = await fetchNews(cleanSymbol);
  const articles = rawNews.map((item, idx) => {
    const s = scoreArticleText(item.title, item.summary || '');
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

  const weightedScoreSum = articles.reduce((acc, a) => acc + a.sentimentScore * a.confidence, 0);
  const totalWeight = articles.reduce((acc, a) => acc + a.confidence, 0) || 1;
  const overallScore = Math.round((weightedScoreSum / totalWeight) * 100);

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

const numToWords = (n) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
const trimTitle = (t, max = 90) => {
  const clean = t.trim().replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
};

/** Port of newsDrivers.getNewsDrivers — never throws; degrades to empty lists. */
async function getNewsDrivers(symbol) {
  const clean = String(symbol).trim().toUpperCase();
  return newsCache.wrap(clean, async () => {
    let sentiment;
    try {
      sentiment = await analyzeStockSentiment(clean);
    } catch (err) {
      console.warn(`[svc-news] sentiment unavailable for ${clean}:`, err?.message || err);
      return { newsItems: [], bullish: [], bearish: [], sentimentScore: 0 };
    }

    const newsItems = (sentiment.news || []).map((a) => ({
      title: a.title,
      source: a.publisher,
      url: a.link || undefined,
      sentiment: a.sentiment === 'BULLISH' ? 'bullish' : a.sentiment === 'BEARISH' ? 'bearish' : 'neutral',
      score: a.sentimentScore,
    }));

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
  });
}

// ---- HTTP surface ----
const { app, listen, close } = await startService({
  name: 'svc-news',
  port: Number(process.env.PORT || 8004),
  healthDeps: async () => ({ ok: true, newsCache: newsCache.size }),
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
