import YahooFinance from 'yahoo-finance2';
import { StockQuote, Candle } from '@/types';

class MarketDataService {
  private yf: InstanceType<typeof YahooFinance>;

  constructor() {
    this.yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }

  /**
   * Get single stock quote
   */
  async getQuote(symbol: string): Promise<StockQuote> {
    const cleanSymbol = symbol.trim().toUpperCase();
    try {
      const q = await this.yf.quote(cleanSymbol);
      return {
        symbol: cleanSymbol,
        name: q.shortName || q.longName || cleanSymbol,
        price: q.regularMarketPrice || 0,
        change: q.regularMarketChange || 0,
        changePercent: q.regularMarketChangePercent || 0,
        open: q.regularMarketOpen || q.regularMarketPrice || 0,
        high: q.regularMarketDayHigh || q.regularMarketPrice || 0,
        low: q.regularMarketDayLow || q.regularMarketPrice || 0,
        previousClose: q.regularMarketPreviousClose || q.regularMarketPrice || 0,
        volume: q.regularMarketVolume || 0,
        avgVolume: q.averageDailyVolume3Month || q.regularMarketVolume || 0,
        marketCap: q.marketCap || 0,
        peRatio: q.trailingPE || undefined,
        week52High: q.fiftyTwoWeekHigh || 0,
        week52Low: q.fiftyTwoWeekLow || 0,
        currency: q.currency || 'USD',
        exchange: q.exchange || 'NASDAQ',
        marketState: (q.marketState as 'PRE' | 'REGULAR' | 'POST' | 'CLOSED') || 'CLOSED',
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error(`Error fetching quote for ${symbol}:`, error);
      throw new Error(`Unable to fetch quote for ${symbol}`);
    }
  }

  /**
   * Batch fetch quotes for multiple symbols
   */
  async getBatchQuotes(symbols: string[]): Promise<StockQuote[]> {
    const results = await Promise.allSettled(
      symbols.map((sym) => this.getQuote(sym))
    );
    return results
      .filter((r): r is PromiseFulfilledResult<StockQuote> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * Fetch historical candles for charting
   */
  async getHistoricalCandles(
    symbol: string,
    timeframe: '1d' | '5d' | '1mo' | '6mo' | '1y' | '2y' | '5y' = '1y',
    interval: '1m' | '5m' | '15m' | '1h' | '1d' | '1wk' = '1d'
  ): Promise<Candle[]> {
    const cleanSymbol = symbol.trim().toUpperCase();
    const now = new Date();
    let period1 = new Date();

    switch (timeframe) {
      case '1d':
        period1.setDate(now.getDate() - 2);
        break;
      case '5d':
        period1.setDate(now.getDate() - 7);
        break;
      case '1mo':
        period1.setMonth(now.getMonth() - 1);
        break;
      case '6mo':
        period1.setMonth(now.getMonth() - 6);
        break;
      case '1y':
        period1.setFullYear(now.getFullYear() - 1);
        break;
      case '2y':
        period1.setFullYear(now.getFullYear() - 2);
        break;
      case '5y':
        period1.setFullYear(now.getFullYear() - 5);
        break;
      default:
        period1.setFullYear(now.getFullYear() - 1);
    }

    try {
      const chartResult = await this.yf.chart(cleanSymbol, {
        period1: period1.toISOString().split('T')[0],
        interval: interval as any,
      });

      if (!chartResult.quotes || chartResult.quotes.length === 0) {
        return [];
      }

      return chartResult.quotes
        .filter((q) => q.open !== null && q.close !== null && q.high !== null && q.low !== null)
        .map((q) => {
          const d = new Date(q.date);
          const timeStr = d.toISOString().split('T')[0];
          return {
            time: timeStr,
            open: Number((q.open ?? 0).toFixed(2)),
            high: Number((q.high ?? 0).toFixed(2)),
            low: Number((q.low ?? 0).toFixed(2)),
            close: Number((q.close ?? 0).toFixed(2)),
            volume: q.volume || 0,
          };
        });
    } catch (error) {
      console.error(`Error fetching historical candles for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * Search symbols/companies
   */
  async searchSymbols(query: string): Promise<Array<{ symbol: string; name: string; exchange: string; type: string }>> {
    if (!query || query.trim().length === 0) return [];
    try {
      const res = await this.yf.search(query, { newsCount: 0 });
      return (res.quotes || [])
        .filter((q: any) => q.isYahooFinance)
        .map((q: any) => ({
          symbol: q.symbol,
          name: q.shortname || q.longname || q.symbol,
          exchange: q.exchange || '',
          type: q.quoteType || 'EQUITY',
        }));
    } catch (error) {
      console.error(`Error searching symbols for query "${query}":`, error);
      return [];
    }
  }

  /**
   * Get major market index benchmark quotes
   */
  async getMarketIndices(): Promise<StockQuote[]> {
    const indices = ['^GSPC', '^IXIC', '^DJI', '^RUT'];
    return this.getBatchQuotes(indices);
  }
}

export const marketDataService = new MarketDataService();
