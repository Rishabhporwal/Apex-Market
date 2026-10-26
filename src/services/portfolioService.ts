import { PortfolioPosition, PortfolioState, PortfolioTransaction } from '@/types';
import { marketDataService } from './marketDataService';

/**
 * Paper-portfolio engine + persistence.
 *
 * All trade logic (cash checks, avg-price math, weight computation) lives HERE
 * — the userdata service is only a durable blob store (GET/PUT per client via
 * the gateway's /api/portfolio-state route). Without the mesh or without a
 * client id, the service degrades to the original in-memory single-tenant
 * behavior (legacy `this.state`), so the platform still works keyless/local.
 *
 * Identity: the BFF route extracts the `apex_cid` cookie (anonymous device id)
 * and passes it down. State is loaded from the gateway once per client per
 * process, then cached in memory and saved back after every mutation
 * (fire-and-forget; a failed save never fails the trade).
 */
class PortfolioService {
  private state: PortfolioState = PortfolioService.defaultState();

  // Per-client states loaded from svc-userdata. Key: clientId.
  private clientStates = new Map<string, PortfolioState>();
  private loadedClients = new Set<string>();

  private static defaultState(): PortfolioState {
    return {
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
  }

  // ---- persistence helpers ---------------------------------------------------

  private gatewayBase(): string | null {
    const base = process.env.API_GATEWAY_URL;
    return base ? base.replace(/\/$/, '') : null;
  }

  /** Load the client's persisted state once per process (best effort). */
  private async ensureLoaded(clientId?: string): Promise<void> {
    if (!clientId || this.loadedClients.has(clientId)) return;
    this.loadedClients.add(clientId);
    const base = this.gatewayBase();
    if (!base) return;
    try {
      const res = await fetch(`${base}/api/portfolio-state`, {
        headers: { 'x-client-id': clientId },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return; // no saved state / service down → default state
      const body = await res.json();
      if (body?.state && typeof body.state === 'object') {
        // Merge over defaults so new fields added later never break old blobs.
        this.clientStates.set(clientId, { ...PortfolioService.defaultState(), ...body.state });
      }
    } catch {
      // Degrade to in-memory; next mutation will re-attempt the save anyway.
    }
  }

  /** Save the client's state to svc-userdata (best effort, never throws). */
  private persist(clientId?: string | null, state?: PortfolioState): void {
    if (!clientId || !state) return;
    const base = this.gatewayBase();
    if (!base) return;
    void fetch(`${base}/api/portfolio-state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-client-id': clientId },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {/* logged? keep silent — persistence is best effort */});
  }

  private get(clientId?: string): PortfolioState {
    return clientId ? (this.clientStates.get(clientId) ?? this.state) : this.state;
  }

  private set(clientId: string | undefined, state: PortfolioState): void {
    if (clientId) this.clientStates.set(clientId, state);
    else this.state = state;
    this.persist(clientId, state);
  }

  // ---- public API ------------------------------------------------------------

  /**
   * Get current portfolio overview state with live quote valuations
   */
  async getPortfolioState(clientId?: string): Promise<PortfolioState> {
    await this.ensureLoaded(clientId);
    const state = this.get(clientId);

    if (state.positions.length === 0) {
      state.totalEquity = state.cashBalance;
      state.totalPnL = state.cashBalance - state.initialBalance;
      state.totalPnLPercent = ((state.totalEquity - state.initialBalance) / state.initialBalance) * 100;
      return state;
    }

    // Update position values with latest live market prices
    const symbols = state.positions.map((p) => p.symbol);
    const quotes = await marketDataService.getBatchQuotes(symbols);

    let totalPositionsValue = 0;

    state.positions = state.positions.map((pos) => {
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

    const totalEquity = state.cashBalance + totalPositionsValue;
    state.totalEquity = Number(totalEquity.toFixed(2));
    state.totalPnL = Number((totalEquity - state.initialBalance).toFixed(2));
    state.totalPnLPercent = Number((((totalEquity - state.initialBalance) / state.initialBalance) * 100).toFixed(2));

    // Calculate weight percentage of each holding
    state.positions = state.positions.map((pos) => ({
      ...pos,
      weightPercent: totalEquity > 0 ? Number(((pos.currentValue / totalEquity) * 100).toFixed(1)) : 0,
    }));

    return state;
  }

  /**
   * Execute paper trade order (Market Buy or Sell)
   */
  async executeOrder(
    symbol: string,
    type: 'BUY' | 'SELL',
    shares: number,
    clientId?: string
  ): Promise<{ success: boolean; message: string; state: PortfolioState }> {
    await this.ensureLoaded(clientId);
    const state = this.get(clientId);

    if (shares <= 0) {
      return { success: false, message: 'Shares must be greater than 0', state: await this.getPortfolioState(clientId) };
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    const quote = await marketDataService.getQuote(cleanSymbol);
    const currentPrice = quote.price;

    if (currentPrice <= 0) {
      return { success: false, message: `Could not retrieve live price for ${cleanSymbol}`, state: await this.getPortfolioState(clientId) };
    }

    const totalAmount = shares * currentPrice;

    if (type === 'BUY') {
      if (state.cashBalance < totalAmount) {
        return {
          success: false,
          message: `Insufficient cash. Required: $${totalAmount.toFixed(2)}, Available: $${state.cashBalance.toFixed(2)}`,
          state: await this.getPortfolioState(clientId),
        };
      }

      state.cashBalance -= totalAmount;

      const existingIndex = state.positions.findIndex((p) => p.symbol === cleanSymbol);
      if (existingIndex >= 0) {
        const existing = state.positions[existingIndex];
        const newShares = existing.shares + shares;
        const newAvgPrice = (existing.shares * existing.avgBuyPrice + totalAmount) / newShares;
        state.positions[existingIndex] = {
          ...existing,
          shares: newShares,
          avgBuyPrice: Number(newAvgPrice.toFixed(2)),
          currentPrice,
          currentValue: Number((newShares * currentPrice).toFixed(2)),
          unrealizedPnL: Number((newShares * (currentPrice - newAvgPrice)).toFixed(2)),
          unrealizedPnLPercent: Number((((currentPrice - newAvgPrice) / newAvgPrice) * 100).toFixed(2)),
        };
      } else {
        state.positions.push({
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
      state.transactions.unshift(tx);
    } else {
      // SELL
      const existingIndex = state.positions.findIndex((p) => p.symbol === cleanSymbol);
      if (existingIndex < 0 || state.positions[existingIndex].shares < shares) {
        return {
          success: false,
          message: `Cannot sell ${shares} shares of ${cleanSymbol}. You only hold ${existingIndex >= 0 ? state.positions[existingIndex].shares : 0} shares.`,
          state: await this.getPortfolioState(clientId),
        };
      }

      state.cashBalance += totalAmount;
      const existing = state.positions[existingIndex];
      const remainingShares = existing.shares - shares;

      if (remainingShares === 0) {
        state.positions.splice(existingIndex, 1);
      } else {
        state.positions[existingIndex] = {
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
      state.transactions.unshift(tx);
    }

    this.set(clientId, state);
    const updatedState = await this.getPortfolioState(clientId);
    return {
      success: true,
      message: `Successfully executed ${type} ${shares} shares of ${cleanSymbol} @ $${currentPrice.toFixed(2)}`,
      state: updatedState,
    };
  }

  /**
   * Reset portfolio to initial cash
   */
  async resetPortfolio(initialCash: number = 100000, clientId?: string): Promise<PortfolioState> {
    await this.ensureLoaded(clientId);
    const current = this.get(clientId);
    const fresh: PortfolioState = {
      ...PortfolioService.defaultState(),
      cashBalance: initialCash,
      initialBalance: initialCash,
      totalEquity: initialCash,
      watchlists: current.watchlists,
    };
    this.set(clientId, fresh);
    return fresh;
  }

  /**
   * Add ticker to watchlist
   */
  async addToWatchlist(watchlistId: string, symbol: string, clientId?: string): Promise<boolean> {
    await this.ensureLoaded(clientId);
    const state = this.get(clientId);
    const cleanSymbol = symbol.trim().toUpperCase();
    const wl = state.watchlists.find((w) => w.id === watchlistId) || state.watchlists[0];
    if (wl && !wl.symbols.includes(cleanSymbol)) {
      wl.symbols.push(cleanSymbol);
      this.set(clientId, state);
      return true;
    }
    return false;
  }

  /**
   * Remove ticker from watchlist
   */
  async removeFromWatchlist(watchlistId: string, symbol: string, clientId?: string): Promise<boolean> {
    await this.ensureLoaded(clientId);
    const state = this.get(clientId);
    const cleanSymbol = symbol.trim().toUpperCase();
    const wl = state.watchlists.find((w) => w.id === watchlistId) || state.watchlists[0];
    if (wl) {
      wl.symbols = wl.symbols.filter((s) => s !== cleanSymbol);
      this.set(clientId, state);
      return true;
    }
    return false;
  }
}

export const portfolioService = new PortfolioService();
