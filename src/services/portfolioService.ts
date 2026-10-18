import { PortfolioPosition, PortfolioState, PortfolioTransaction } from '@/types';
import { marketDataService } from './marketDataService';

class PortfolioService {
  private state: PortfolioState = {
    cashBalance: 100000,
    initialBalance: 100000,
    totalEquity: 100000,
    totalPnL: 0,
    totalPnLPercent: 0,
    positions: [],
    transactions: [],
    watchlists: [
      {
        id: 'wl-default',
        name: 'Core Tech & AI Leaders',
        symbols: ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'PLTR', 'AMD'],
      },
      {
        id: 'wl-value',
        name: 'Dividend & Value',
        symbols: ['JPM', 'XOM', 'WMT', 'COST', 'PG'],
      },
    ],
  };

  /**
   * Get current portfolio overview state with live quote valuations
   */
  async getPortfolioState(): Promise<PortfolioState> {
    if (this.state.positions.length === 0) {
      this.state.totalEquity = this.state.cashBalance;
      this.state.totalPnL = this.state.cashBalance - this.state.initialBalance;
      this.state.totalPnLPercent = ((this.state.totalEquity - this.state.initialBalance) / this.state.initialBalance) * 100;
      return this.state;
    }

    // Update position values with latest live market prices
    const symbols = this.state.positions.map((p) => p.symbol);
    const quotes = await marketDataService.getBatchQuotes(symbols);

    let totalPositionsValue = 0;

    this.state.positions = this.state.positions.map((pos) => {
      const q = quotes.find((quote) => quote.symbol === pos.symbol);
      const currentPrice = q ? q.price : pos.currentPrice;
      const currentValue = pos.shares * currentPrice;
      const costBasis = pos.shares * pos.avgBuyPrice;
      const unrealizedPnL = currentValue - costBasis;
      const unrealizedPnLPercent = costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;

      totalPositionsValue += currentValue;

      return {
        ...pos,
        currentPrice: Number(currentPrice.toFixed(2)),
        currentValue: Number(currentValue.toFixed(2)),
        unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
        unrealizedPnLPercent: Number(unrealizedPnLPercent.toFixed(2)),
        weightPercent: 0, // Will compute below once total is known
      };
    });

    const totalEquity = this.state.cashBalance + totalPositionsValue;
    this.state.totalEquity = Number(totalEquity.toFixed(2));
    this.state.totalPnL = Number((totalEquity - this.state.initialBalance).toFixed(2));
    this.state.totalPnLPercent = Number((((totalEquity - this.state.initialBalance) / this.state.initialBalance) * 100).toFixed(2));

    // Calculate weight percentage of each holding
    this.state.positions = this.state.positions.map((pos) => ({
      ...pos,
      weightPercent: totalEquity > 0 ? Number(((pos.currentValue / totalEquity) * 100).toFixed(1)) : 0,
    }));

    return this.state;
  }

  /**
   * Execute paper trade order (Market Buy or Sell)
   */
  async executeOrder(
    symbol: string,
    type: 'BUY' | 'SELL',
    shares: number
  ): Promise<{ success: boolean; message: string; state: PortfolioState }> {
    if (shares <= 0) {
      return { success: false, message: 'Shares must be greater than 0', state: await this.getPortfolioState() };
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    const quote = await marketDataService.getQuote(cleanSymbol);
    const currentPrice = quote.price;

    if (currentPrice <= 0) {
      return { success: false, message: `Could not retrieve live price for ${cleanSymbol}`, state: await this.getPortfolioState() };
    }

    const totalAmount = shares * currentPrice;

    if (type === 'BUY') {
      if (this.state.cashBalance < totalAmount) {
        return {
          success: false,
          message: `Insufficient cash. Required: $${totalAmount.toFixed(2)}, Available: $${this.state.cashBalance.toFixed(2)}`,
          state: await this.getPortfolioState(),
        };
      }

      this.state.cashBalance -= totalAmount;

      const existingIndex = this.state.positions.findIndex((p) => p.symbol === cleanSymbol);
      if (existingIndex >= 0) {
        const existing = this.state.positions[existingIndex];
        const newShares = existing.shares + shares;
        const newAvgPrice = (existing.shares * existing.avgBuyPrice + totalAmount) / newShares;
        this.state.positions[existingIndex] = {
          ...existing,
          shares: newShares,
          avgBuyPrice: Number(newAvgPrice.toFixed(2)),
          currentPrice,
          currentValue: Number((newShares * currentPrice).toFixed(2)),
          unrealizedPnL: Number((newShares * (currentPrice - newAvgPrice)).toFixed(2)),
          unrealizedPnLPercent: Number((((currentPrice - newAvgPrice) / newAvgPrice) * 100).toFixed(2)),
        };
      } else {
        this.state.positions.push({
          symbol: cleanSymbol,
          name: quote.name,
          shares,
          avgBuyPrice: currentPrice,
          currentPrice,
          currentValue: totalAmount,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
          weightPercent: 0,
        });
      }

      const tx: PortfolioTransaction = {
        id: `tx-${Date.now()}`,
        symbol: cleanSymbol,
        type: 'BUY',
        shares,
        price: currentPrice,
        totalAmount: Number(totalAmount.toFixed(2)),
        timestamp: Date.now(),
      };
      this.state.transactions.unshift(tx);
    } else {
      // SELL
      const existingIndex = this.state.positions.findIndex((p) => p.symbol === cleanSymbol);
      if (existingIndex < 0 || this.state.positions[existingIndex].shares < shares) {
        return {
          success: false,
          message: `Cannot sell ${shares} shares of ${cleanSymbol}. You only hold ${existingIndex >= 0 ? this.state.positions[existingIndex].shares : 0} shares.`,
          state: await this.getPortfolioState(),
        };
      }

      this.state.cashBalance += totalAmount;
      const existing = this.state.positions[existingIndex];
      const remainingShares = existing.shares - shares;

      if (remainingShares === 0) {
        this.state.positions.splice(existingIndex, 1);
      } else {
        this.state.positions[existingIndex] = {
          ...existing,
          shares: remainingShares,
          currentValue: Number((remainingShares * currentPrice).toFixed(2)),
          unrealizedPnL: Number((remainingShares * (currentPrice - existing.avgBuyPrice)).toFixed(2)),
          unrealizedPnLPercent: Number((((currentPrice - existing.avgBuyPrice) / existing.avgBuyPrice) * 100).toFixed(2)),
        };
      }

      const tx: PortfolioTransaction = {
        id: `tx-${Date.now()}`,
        symbol: cleanSymbol,
        type: 'SELL',
        shares,
        price: currentPrice,
        totalAmount: Number(totalAmount.toFixed(2)),
        timestamp: Date.now(),
      };
      this.state.transactions.unshift(tx);
    }

    const updatedState = await this.getPortfolioState();
    return {
      success: true,
      message: `Successfully executed ${type} ${shares} shares of ${cleanSymbol} @ $${currentPrice.toFixed(2)}`,
      state: updatedState,
    };
  }

  /**
   * Reset portfolio to initial cash
   */
  resetPortfolio(initialCash: number = 100000): PortfolioState {
    this.state = {
      cashBalance: initialCash,
      initialBalance: initialCash,
      totalEquity: initialCash,
      totalPnL: 0,
      totalPnLPercent: 0,
      positions: [],
      transactions: [],
      watchlists: this.state.watchlists,
    };
    return this.state;
  }

  /**
   * Add ticker to watchlist
   */
  addToWatchlist(watchlistId: string, symbol: string): boolean {
    const cleanSymbol = symbol.trim().toUpperCase();
    const wl = this.state.watchlists.find((w) => w.id === watchlistId) || this.state.watchlists[0];
    if (wl && !wl.symbols.includes(cleanSymbol)) {
      wl.symbols.push(cleanSymbol);
      return true;
    }
    return false;
  }

  /**
   * Remove ticker from watchlist
   */
  removeFromWatchlist(watchlistId: string, symbol: string): boolean {
    const cleanSymbol = symbol.trim().toUpperCase();
    const wl = this.state.watchlists.find((w) => w.id === watchlistId) || this.state.watchlists[0];
    if (wl) {
      wl.symbols = wl.symbols.filter((s) => s !== cleanSymbol);
      return true;
    }
    return false;
  }
}

export const portfolioService = new PortfolioService();
