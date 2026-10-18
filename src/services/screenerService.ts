import { ScreenerFilter, ScreenerStockResult } from '@/types';
import { marketDataService } from './marketDataService';
import { sentimentService } from './sentimentService';

class ScreenerService {
  // Broad universe of major tradeable US stocks across sectors
  private universe = [
    { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Technology' },
    { symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Technology' },
    { symbol: 'NVDA', name: 'NVIDIA Corporation', sector: 'Technology' },
    { symbol: 'GOOGL', name: 'Alphabet Inc.', sector: 'Communication Services' },
    { symbol: 'AMZN', name: 'Amazon.com Inc.', sector: 'Consumer Cyclical' },
    { symbol: 'META', name: 'Meta Platforms Inc.', sector: 'Communication Services' },
    { symbol: 'TSLA', name: 'Tesla Inc.', sector: 'Consumer Cyclical' },
    { symbol: 'AVGO', name: 'Broadcom Inc.', sector: 'Technology' },
    { symbol: 'AMD', name: 'Advanced Micro Devices', sector: 'Technology' },
    { symbol: 'JPM', name: 'JPMorgan Chase & Co.', sector: 'Financial Services' },
    { symbol: 'V', name: 'Visa Inc.', sector: 'Financial Services' },
    { symbol: 'LLY', name: 'Eli Lilly and Company', sector: 'Healthcare' },
    { symbol: 'UNH', name: 'UnitedHealth Group', sector: 'Healthcare' },
    { symbol: 'XOM', name: 'Exxon Mobil Corporation', sector: 'Energy' },
    { symbol: 'CVX', name: 'Chevron Corporation', sector: 'Energy' },
    { symbol: 'WMT', name: 'Walmart Inc.', sector: 'Consumer Defensive' },
    { symbol: 'COST', name: 'Costco Wholesale Corp.', sector: 'Consumer Defensive' },
    { symbol: 'PG', name: 'Procter & Gamble Co.', sector: 'Consumer Defensive' },
    { symbol: 'PLTR', name: 'Palantir Technologies', sector: 'Technology' },
    { symbol: 'CRM', name: 'Salesforce Inc.', sector: 'Technology' },
    { symbol: 'NFLX', name: 'Netflix Inc.', sector: 'Communication Services' },
    { symbol: 'DIS', name: 'Walt Disney Co.', sector: 'Communication Services' },
    { symbol: 'CAT', name: 'Caterpillar Inc.', sector: 'Industrials' },
    { symbol: 'GE', name: 'GE Aerospace', sector: 'Industrials' },
    { symbol: 'BA', name: 'Boeing Co.', sector: 'Industrials' },
  ];

  /**
   * Screen stocks based on multi-variable criteria
   */
  async screenStocks(filters: ScreenerFilter): Promise<ScreenerStockResult[]> {
    // 1. Filter by sector initially if specified
    const targetUniverse = filters.sector && filters.sector !== 'ALL'
      ? this.universe.filter((item) => item.sector.toLowerCase() === filters.sector?.toLowerCase())
      : this.universe;

    // 2. Fetch quotes for universe
    const symbols = targetUniverse.map((u) => u.symbol);
    const quotes = await marketDataService.getBatchQuotes(symbols);

    const enrichedResults: ScreenerStockResult[] = [];

    for (const q of quotes) {
      const info = targetUniverse.find((u) => u.symbol === q.symbol);
      const sector = info?.sector || 'Equities';

      // Deterministic / synthetic indicator & sentiment assignment for responsiveness
      const rsi14 = this.estimateRSI(q.changePercent, q.price, q.week52High, q.week52Low);
      const sentimentScore = this.estimateSentiment(q.symbol, q.changePercent);
      const sentimentLabel =
        sentimentScore >= 45
          ? 'Strongly Bullish'
          : sentimentScore >= 15
          ? 'Bullish'
          : sentimentScore <= -45
          ? 'Strongly Bearish'
          : sentimentScore <= -15
          ? 'Bearish'
          : 'Neutral';

      const dividendYield = this.estimateDividend(q.symbol, sector);
      const beta = this.estimateBeta(sector, q.changePercent);

      const item: ScreenerStockResult = {
        symbol: q.symbol,
        name: q.name,
        sector,
        price: q.price,
        changePercent: q.changePercent,
        marketCap: q.marketCap,
        peRatio: q.peRatio,
        dividendYield,
        beta,
        rsi14,
        sentimentScore,
        sentimentLabel,
        volume: q.volume,
      };

      // 3. Apply Filters
      if (filters.minMarketCap && item.marketCap < filters.minMarketCap) continue;
      if (filters.maxMarketCap && item.marketCap > filters.maxMarketCap) continue;
      if (filters.minPE && (item.peRatio === undefined || item.peRatio < filters.minPE)) continue;
      if (filters.maxPE && (item.peRatio === undefined || item.peRatio > filters.maxPE)) continue;
      if (filters.minDividendYield && (item.dividendYield === undefined || item.dividendYield < filters.minDividendYield)) continue;
      if (filters.maxDividendYield && (item.dividendYield === undefined || item.dividendYield > filters.maxDividendYield)) continue;
      if (filters.minBeta && (item.beta === undefined || item.beta < filters.minBeta)) continue;
      if (filters.maxBeta && (item.beta === undefined || item.beta > filters.maxBeta)) continue;
      if (filters.minRSI && (item.rsi14 === undefined || item.rsi14 < filters.minRSI)) continue;
      if (filters.maxRSI && (item.rsi14 === undefined || item.rsi14 > filters.maxRSI)) continue;
      if (filters.minSentimentScore && item.sentimentScore < filters.minSentimentScore) continue;

      if (filters.pricePerformance === 'GAINER_TODAY' && item.changePercent <= 0) continue;
      if (filters.pricePerformance === 'LOSER_TODAY' && item.changePercent >= 0) continue;
      if (filters.pricePerformance === 'NEAR_52W_HIGH') {
        const distToHigh = ((q.week52High - q.price) / q.week52High) * 100;
        if (distToHigh > 5) continue;
      }
      if (filters.pricePerformance === 'NEAR_52W_LOW') {
        const distToLow = ((q.price - q.week52Low) / q.week52Low) * 100;
        if (distToLow > 10) continue;
      }

      enrichedResults.push(item);
    }

    // 4. Sort results
    const sortBy = filters.sortBy || 'marketCap';
    const sortOrder = filters.sortOrder || 'desc';

    enrichedResults.sort((a, b) => {
      let valA = a[sortBy] ?? 0;
      let valB = b[sortBy] ?? 0;
      if (typeof valA === 'string') valA = Number(valA);
      if (typeof valB === 'string') valB = Number(valB);
      return sortOrder === 'desc' ? (valB as number) - (valA as number) : (valA as number) - (valB as number);
    });

    return enrichedResults;
  }

  // Helpers to estimate technicals & sentiment efficiently for screener universe
  private estimateRSI(changePercent: number, price: number, high52: number, low52: number): number {
    const range = high52 - low52 || 1;
    const pos = (price - low52) / range;
    const rsi = Math.round(30 + pos * 40 + changePercent * 2);
    return Math.max(12, Math.min(88, rsi));
  }

  private estimateSentiment(symbol: string, changePercent: number): number {
    const base = ['NVDA', 'AAPL', 'MSFT', 'PLTR', 'LLY'].includes(symbol) ? 35 : 10;
    const score = Math.round(base + changePercent * 8);
    return Math.max(-95, Math.min(95, score));
  }

  private estimateDividend(symbol: string, sector: string): number {
    if (sector === 'Energy') return 3.4;
    if (sector === 'Financial Services') return 2.2;
    if (sector === 'Consumer Defensive') return 2.6;
    if (['AAPL', 'MSFT'].includes(symbol)) return 0.7;
    return 0.0;
  }

  private estimateBeta(sector: string, changePercent: number): number {
    if (sector === 'Technology') return 1.35;
    if (sector === 'Consumer Cyclical') return 1.45;
    if (sector === 'Consumer Defensive') return 0.65;
    if (sector === 'Healthcare') return 0.75;
    return 1.05;
  }
}

export const screenerService = new ScreenerService();
