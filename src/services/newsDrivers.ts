import { sentimentService } from '@/services/sentimentService';
import { newsCache } from '@/services/cacheService';
import type { SentimentAnalysisResult } from '@/types';
import type { VerdictNewsItem } from '@/types/verdict';

export interface NewsDriversResult {
  newsItems: VerdictNewsItem[];
  bullish: string[];
  bearish: string[];
  sentimentScore: number; // -100..100 aggregate
}

function numToWords(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return words[n] ?? String(n);
}

/**
 * Wraps sentimentService: normalizes its articles into plain newsItems and
 * produces human-readable bullish/bearish driver bullets.
 * Never throws — any failure degrades to empty lists with score 0.
 */
export async function getNewsDrivers(symbol: string): Promise<NewsDriversResult> {
  const clean = symbol.trim().toUpperCase();
  // 10min TTL cache — verdicts re-run frequently but news doesn't change that fast
  return newsCache.wrap(clean, async () => {
    let sentiment: SentimentAnalysisResult | null = null;
    try {
      sentiment = await sentimentService.analyzeStockSentiment(clean);
    } catch (err) {
      console.warn(`[newsDrivers] sentiment unavailable for ${clean}:`, err);
      return { newsItems: [], bullish: [], bearish: [], sentimentScore: 0 };
    }

  const newsItems: VerdictNewsItem[] = (sentiment.news || []).map((a) => ({
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

  const bullish: string[] = [];
  const bearish: string[] = [];

  if (total === 0) {
    bullish.push('No recent headlines available — news sentiment is not factored into this verdict.');
  } else {
    if (bullishCount > 0) {
      const topBull = newsItems
        .filter((n) => n.sentiment === 'bullish')
        .sort((a, b) => b.score - a.score)[0];
      bullish.push(
        `${numToWords(bullishCount).replace(/^one$/, 'One')} of the last ${numToWords(total)} headline${total > 1 ? 's' : ''} ${bullishCount === 1 ? 'was' : 'were'} positive — the strongest reads "${trimTitle(topBull.title)}".`
      );
    }
    if (neutralCount > 0 && neutralCount >= bullishCount && neutralCount >= bearishCount) {
      bullish.push(
        `Most coverage (${neutralCount} of ${numToWords(total)} stories) is neutral, so news flow is not adding strong pressure either way.`
      );
    }
    if (score >= 20) {
      bullish.push(`Overall news mood is clearly positive (score ${score}/100) — headlines lean toward growth and momentum.`);
    } else if (score >= 5) {
      bullish.push(`News flow tilts mildly positive (score ${score}/100).`);
    }
    if (bearishCount > 0) {
      const topBear = newsItems
        .filter((n) => n.sentiment === 'bearish')
        .sort((a, b) => a.score - b.score)[0];
      bearish.push(
        `${numToWords(bearishCount).replace(/^one$/, 'One')} of the last ${numToWords(total)} headline${total > 1 ? 's' : ''} ${bearishCount === 1 ? 'was' : 'were'} negative — the most concerning reads "${trimTitle(topBear.title)}".`
      );
    }
    if (score <= -20) {
      bearish.push(`Overall news mood is clearly negative (score ${score}/100) — watch for continued downside pressure.`);
    } else if (score <= -5) {
      bearish.push(`News flow tilts mildly negative (score ${score}/100).`);
    }
  }

  return { newsItems, bullish, bearish, sentimentScore: score };
  });
}

function trimTitle(t: string, max = 90): string {
  const clean = t.trim().replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}


