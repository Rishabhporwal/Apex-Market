'use client';

import React, { useState, useEffect } from 'react';
import { 
  Briefcase, 
  DollarSign, 
  TrendingUp, 
  TrendingDown, 
  Plus, 
  Trash2, 
  RotateCcw, 
  ArrowUpRight, 
  ArrowDownRight, 
  CheckCircle2, 
  AlertCircle,
  Clock,
  PieChart,
  RefreshCw
} from 'lucide-react';
import { PortfolioState, StockQuote } from '@/types';

interface PortfolioViewProps {
  onSelectSymbol: (symbol: string) => void;
  activeSymbol: string;
}

export function PortfolioView({ onSelectSymbol, activeSymbol }: PortfolioViewProps) {
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [loading, setLoading] = useState(true);

  // Trade Ticket state
  const [tradeSymbol, setTradeSymbol] = useState(activeSymbol || 'NVDA');
  const [tradeType, setTradeType] = useState<'BUY' | 'SELL'>('BUY');
  const [tradeShares, setTradeShares] = useState<number>(10);
  const [executing, setExecuting] = useState(false);
  const [tradeMessage, setTradeMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // New Watchlist symbol input
  const [newWatchlistSymbol, setNewWatchlistSymbol] = useState('');

  // Fetch portfolio state
  const loadPortfolio = async () => {
    try {
      const res = await fetch('/api/portfolio');
      if (res.ok) {
        const data = await res.json();
        setPortfolio(data);
      }
    } catch (err) {
      console.error('Failed to load portfolio:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPortfolio();
  }, []);

  useEffect(() => {
    if (activeSymbol) {
      setTradeSymbol(activeSymbol);
    }
  }, [activeSymbol]);

  // Execute Order
  const handleExecuteTrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (tradeShares <= 0) return;

    setExecuting(true);
    setTradeMessage(null);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'trade',
          symbol: tradeSymbol.toUpperCase(),
          type: tradeType,
          shares: tradeShares,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setPortfolio(data.state);
        setTradeMessage({ text: data.message, isError: false });
      } else {
        setTradeMessage({ text: data.message || 'Execution failed', isError: true });
      }
    } catch (err: any) {
      setTradeMessage({ text: err.message || 'Network error', isError: true });
    } finally {
      setExecuting(false);
    }
  };

  // Reset Account
  const handleReset = async () => {
    if (!confirm('Are you sure you want to reset your simulated portfolio to $100,000 cash?')) return;
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset', initialCash: 100000 }),
      });
      if (res.ok) {
        const data = await res.json();
        setPortfolio(data.state);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Add symbol to watchlist
  const handleAddWatchlist = async () => {
    if (!newWatchlistSymbol.trim()) return;
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'watchlist_add',
          symbol: newWatchlistSymbol.trim().toUpperCase(),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPortfolio(data.state);
        setNewWatchlistSymbol('');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Remove symbol from watchlist
  const handleRemoveWatchlist = async (sym: string) => {
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'watchlist_remove',
          symbol: sym,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPortfolio(data.state);
      }
    } catch (e) {
      console.error(e);
    }
  };

  if (loading || !portfolio) {
    return (
      <div className="glass-panel rounded-2xl p-12 text-center text-slate-400 font-mono">
        <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-3 text-cyan-400" />
        Loading paper trading portfolio ledger...
      </div>
    );
  }

  const isProfitable = portfolio.totalPnL >= 0;

  return (
    <div className="space-y-6">
      {/* Portfolio Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel rounded-2xl p-5 border border-slate-800">
          <div className="text-[11px] font-mono uppercase text-slate-400">Total Portfolio Value</div>
          <div className="text-2xl font-extrabold font-mono text-white mt-1">
            ${portfolio.totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">
            Starting: ${portfolio.initialBalance.toLocaleString()}
          </div>
        </div>

        <div className="glass-panel rounded-2xl p-5 border border-slate-800">
          <div className="text-[11px] font-mono uppercase text-slate-400">Free Cash Balance</div>
          <div className="text-2xl font-extrabold font-mono text-cyan-400 mt-1">
            ${portfolio.cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">Available for new trades</div>
        </div>

        <div className="glass-panel rounded-2xl p-5 border border-slate-800">
          <div className="text-[11px] font-mono uppercase text-slate-400">Total Net P&L</div>
          <div className={`text-2xl font-extrabold font-mono mt-1 ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isProfitable ? '+' : ''}${portfolio.totalPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className={`text-[11px] font-mono font-bold mt-1 ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
            {isProfitable ? '▲ +' : '▼ '}{portfolio.totalPnLPercent.toFixed(2)}%
          </div>
        </div>

        <div className="glass-panel rounded-2xl p-5 border border-slate-800 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase text-slate-400">Active Positions</span>
            <button
              onClick={handleReset}
              className="flex items-center gap-1 text-[11px] font-mono text-rose-400 hover:text-rose-300 transition"
              title="Reset portfolio to initial cash"
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </button>
          </div>
          <div className="text-2xl font-extrabold font-mono text-white mt-1">
            {portfolio.positions.length} Stocks
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">
            {portfolio.transactions.length} Total orders executed
          </div>
        </div>
      </div>

      {/* Trade Execution Ticket & Watchlists Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trade Execution Ticket */}
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="text-sm font-bold font-mono uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
            <Briefcase className="h-4 w-4 text-cyan-400" /> Simulated Order Ticket
          </h3>

          <form onSubmit={handleExecuteTrade} className="space-y-4 font-mono text-xs">
            {/* Buy / Sell toggle */}
            <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1 rounded-xl border border-slate-800">
              <button
                type="button"
                onClick={() => setTradeType('BUY')}
                className={`py-2 rounded-lg font-bold text-xs transition ${
                  tradeType === 'BUY'
                    ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                BUY / LONG
              </button>
              <button
                type="button"
                onClick={() => setTradeType('SELL')}
                className={`py-2 rounded-lg font-bold text-xs transition ${
                  tradeType === 'SELL'
                    ? 'bg-rose-500 text-slate-950 shadow-md shadow-rose-500/20'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                SELL / CLOSE
              </button>
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] uppercase mb-1">Ticker Symbol</label>
              <input
                type="text"
                value={tradeSymbol}
                onChange={(e) => setTradeSymbol(e.target.value.toUpperCase())}
                placeholder="NVDA"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white font-bold outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block text-slate-400 text-[11px] uppercase mb-1">Number of Shares</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  value={tradeShares}
                  onChange={(e) => setTradeShares(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-white outline-none focus:border-cyan-500"
                />
                <button
                  type="button"
                  onClick={() => setTradeShares(10)}
                  className="px-2.5 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  10
                </button>
                <button
                  type="button"
                  onClick={() => setTradeShares(50)}
                  className="px-2.5 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  50
                </button>
                <button
                  type="button"
                  onClick={() => setTradeShares(100)}
                  className="px-2.5 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  100
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={executing}
              className={`w-full py-2.5 rounded-xl font-bold font-mono text-xs transition shadow-lg ${
                tradeType === 'BUY'
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
                  : 'bg-rose-500 hover:bg-rose-400 text-slate-950 shadow-rose-500/20'
              } disabled:opacity-50`}
            >
              {executing ? 'Executing Order...' : `Execute ${tradeType} Order`}
            </button>

            {tradeMessage && (
              <div
                className={`p-3 rounded-lg border text-xs font-sans ${
                  tradeMessage.isError
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                }`}
              >
                {tradeMessage.text}
              </div>
            )}
          </form>
        </div>

        {/* Watchlists Manager */}
        <div className="glass-panel rounded-2xl p-6 lg:col-span-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-4">
            <div>
              <h3 className="text-sm font-bold font-mono uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <PieChart className="h-4 w-4 text-cyan-400" /> Research Watchlists
              </h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Custom monitored equities</p>
            </div>

            {/* Quick Add Symbol */}
            <div className="flex items-center gap-2 font-mono text-xs">
              <input
                type="text"
                placeholder="Add symbol (e.g. AMD)..."
                value={newWatchlistSymbol}
                onChange={(e) => setNewWatchlistSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleAddWatchlist()}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 outline-none focus:border-cyan-500 w-44"
              />
              <button
                onClick={handleAddWatchlist}
                className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold transition flex items-center gap-1"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
          </div>

          <div className="space-y-4">
            {portfolio.watchlists.map((wl) => (
              <div key={wl.id} className="space-y-2">
                <div className="text-xs font-mono font-bold text-slate-400">{wl.name}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 font-mono text-xs">
                  {wl.symbols.map((sym) => (
                    <div
                      key={sym}
                      className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition"
                    >
                      <button
                        onClick={() => onSelectSymbol(sym)}
                        className="font-bold text-cyan-300 hover:text-cyan-400 transition"
                      >
                        {sym}
                      </button>
                      <button
                        onClick={() => handleRemoveWatchlist(sym)}
                        className="text-slate-500 hover:text-rose-400 transition p-1"
                        title="Remove from watchlist"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Holdings & Positions Table */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="text-base font-bold text-white font-sans mb-3">Active Portfolio Holdings & Positions</h3>

        {portfolio.positions.length === 0 ? (
          <div className="py-12 text-center text-slate-500 font-mono text-xs">
            No active positions yet. Use the simulated order ticket above to buy your first stock with your $100,000 cash balance!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="pb-3 font-semibold">Stock</th>
                  <th className="pb-3 font-semibold">Shares</th>
                  <th className="pb-3 font-semibold">Avg Buy Price</th>
                  <th className="pb-3 font-semibold">Market Price</th>
                  <th className="pb-3 font-semibold">Current Value</th>
                  <th className="pb-3 font-semibold">Unrealized P&L</th>
                  <th className="pb-3 font-semibold">Weight %</th>
                  <th className="pb-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {portfolio.positions.map((pos) => {
                  const isUp = pos.unrealizedPnL >= 0;
                  return (
                    <tr key={pos.symbol} className="hover:bg-slate-800/30 transition">
                      <td className="py-3">
                        <button
                          onClick={() => onSelectSymbol(pos.symbol)}
                          className="font-bold text-cyan-400 hover:underline"
                        >
                          {pos.symbol}
                        </button>
                        <span className="text-slate-500 text-[11px] ml-2">{pos.name}</span>
                      </td>

                      <td className="py-3 text-white">{pos.shares}</td>

                      <td className="py-3 text-slate-300">${pos.avgBuyPrice.toFixed(2)}</td>

                      <td className="py-3 font-bold text-white">${pos.currentPrice.toFixed(2)}</td>

                      <td className="py-3 text-slate-200">${pos.currentValue.toLocaleString()}</td>

                      <td className="py-3 font-bold">
                        <span className={isUp ? 'text-emerald-400' : 'text-rose-400'}>
                          {isUp ? '+' : ''}${pos.unrealizedPnL.toLocaleString()} ({isUp ? '+' : ''}{pos.unrealizedPnLPercent.toFixed(2)}%)
                        </span>
                      </td>

                      <td className="py-3 text-slate-400">{pos.weightPercent}%</td>

                      <td className="py-3 text-right">
                        <button
                          onClick={() => {
                            setTradeSymbol(pos.symbol);
                            setTradeType('SELL');
                            setTradeShares(pos.shares);
                          }}
                          className="px-2.5 py-1 rounded bg-rose-500/15 hover:bg-rose-500 hover:text-slate-950 text-rose-300 text-xs font-semibold transition"
                        >
                          Sell All
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Transaction History Log */}
      {portfolio.transactions.length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="text-base font-bold text-white font-sans mb-3">Executed Transactions Log</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="pb-2 font-semibold">Timestamp</th>
                  <th className="pb-2 font-semibold">Type</th>
                  <th className="pb-2 font-semibold">Symbol</th>
                  <th className="pb-2 font-semibold">Shares</th>
                  <th className="pb-2 font-semibold">Price</th>
                  <th className="pb-2 font-semibold">Total Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {portfolio.transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-slate-800/20 transition">
                    <td className="py-2 text-slate-400">{new Date(tx.timestamp).toLocaleString()}</td>
                    <td className="py-2">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${tx.type === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                        {tx.type}
                      </span>
                    </td>
                    <td className="py-2 font-bold text-white">{tx.symbol}</td>
                    <td className="py-2 text-slate-300">{tx.shares}</td>
                    <td className="py-2 text-slate-300">${tx.price.toFixed(2)}</td>
                    <td className="py-2 font-bold text-slate-200">${tx.totalAmount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
