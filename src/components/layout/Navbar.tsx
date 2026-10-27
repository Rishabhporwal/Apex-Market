'use client';

/**
 * AppShell — Tradexa chrome: VERTICAL SIDEBAR navigation (left, white, 1px
 * slate-200 right border) + slim top strip (ticker tape) + top bar (search,
 * AI models, active symbol). Same 2026 light minimal design language.
 *
 * Layout: the sidebar (w-56) is hidden below the lg breakpoint (~1024px) —
 * narrow viewports get a horizontally scrollable nav strip under the top bar
 * instead (auto-hide, nothing is lost). Quick-ticker chips live at the sidebar
 * bottom on wide screens. All tabs (incl. 💰 Costs), search and its
 * autocomplete stay reachable.
 */
import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  Search,
  Activity,
  BarChart2,
  FileText,
  Sliders,
  Zap,
  Briefcase,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  Target,
  Compass,
  Star,
  Trophy,
  Wallet
} from 'lucide-react';
import { StockQuote } from '@/types';

interface AppShellProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onOpenAiModal?: () => void;
  children: React.ReactNode;
}

const navItems = [
  { id: 'discover', label: 'Discover', icon: Compass },
  { id: 'daily', label: 'Top 5', icon: Trophy },
  { id: 'prediction', label: 'AI Verdict', icon: Target },
  { id: 'chart', label: 'Terminal & Chart', icon: Activity },
  { id: 'financials', label: 'Financials & Valuation', icon: BarChart2 },
  { id: 'filings', label: 'SEC Filings & Calls', icon: FileText },
  { id: 'screener', label: 'Stock Screener', icon: Sliders },
  { id: 'backtest', label: 'Quant Backtester', icon: Zap },
  { id: 'portfolio', label: 'Paper Trading', icon: Briefcase },
  { id: 'watchlist', label: 'Watchlist', icon: Star },
  { id: 'costs', label: '💰 Costs', icon: Wallet },
];

export function AppShell({ activeTab, setActiveTab, selectedSymbol, onSelectSymbol, onOpenAiModal, children }: AppShellProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ symbol: string; name: string }>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [indices, setIndices] = useState<StockQuote[]>([]);

  // Popular quick tickers (sidebar bottom, wide screens)
  const quickTickers = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'TSLA', 'PLTR', 'JPM'];

  // Fetch benchmark index quotes
  useEffect(() => {
    async function loadIndices() {
      try {
        const res = await fetch('/api/market-data?type=indices');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) setIndices(data);
        }
      } catch (err) {
        console.error('Failed to load indices:', err);
      }
    }
    loadIndices();
    const interval = setInterval(loadIndices, 30000);
    return () => clearInterval(interval);
  }, []);

  // Handle Search autocomplete
  useEffect(() => {
    if (searchQuery.trim().length < 1) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(`/api/market-data?type=search&q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.slice(0, 6));
        }
      } catch (e) {
        console.error('Search error:', e);
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const submitSearch = () => {
    if (searchQuery.trim()) {
      onSelectSymbol(searchQuery.trim().toUpperCase());
      setSearchQuery('');
      setSearchResults([]);
    }
  };

  const tickerTape = (
    <div className="border-b border-slate-100 bg-[#fafafa] px-4 py-1.5 text-xs">
      <div className="flex items-center justify-between overflow-x-auto gap-6 no-scrollbar">
        <div className="flex items-center gap-2 text-muted font-mono shrink-0">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">Market Pulse</span>
        </div>

        <div className="flex items-center gap-6 text-xs font-mono shrink-0 tabular-nums">
          {indices.length > 0 ? (
            indices.map((idx) => {
              const isPos = idx.changePercent >= 0;
              const cleanName = idx.symbol === '^GSPC' ? 'S&P 500' : idx.symbol === '^IXIC' ? 'NASDAQ' : idx.symbol === '^DJI' ? 'DOW' : 'RUSSELL 2K';
              return (
                <div key={idx.symbol} className="flex items-center gap-2">
                  <span className="font-medium text-muted">{cleanName}</span>
                  <span className="text-slate-700">{idx.price.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                  <span className={`flex items-center text-xs font-semibold ${isPos ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {isPos ? <ArrowUpRight className="h-3 w-3 mr-0.5" /> : <ArrowDownRight className="h-3 w-3 mr-0.5" />}
                    {isPos ? '+' : ''}{idx.changePercent.toFixed(2)}%
                  </span>
                </div>
              );
            })
          ) : (
            <div className="flex items-center gap-6 text-muted">
              <span>S&P 500: 5,864.6 (+0.40%)</span>
              <span>NASDAQ: 18,374.8 (+0.63%)</span>
              <span>DOW: 43,275.9 (+0.09%)</span>
              <span>10Y YIELD: 4.08% (-0.02)</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const searchBox = (
    <div className="relative w-full max-w-md flex-1">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
        <input
          type="text"
          placeholder={`Search ticker or company (e.g. NVDA, Apple, TSLA)...`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitSearch();
          }}
          className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-20 py-2 text-sm text-slate-900 placeholder-muted outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15 font-mono"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          <span className="rounded bg-slate-50 px-1.5 py-0.5 text-xs font-mono text-muted border border-slate-200">
            ↵ Enter
          </span>
        </div>
      </div>

      {/* Autocomplete Dropdown */}
      {searchResults.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted px-2.5 py-1">
            Matching Symbols
          </div>
          {searchResults.map((item) => (
            <button
              key={item.symbol}
              onClick={() => {
                onSelectSymbol(item.symbol);
                setSearchQuery('');
                setSearchResults([]);
              }}
              className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-slate-900">{item.symbol}</span>
                <span className="text-xs text-muted truncate max-w-[220px]">{item.name}</span>
              </div>
              <span className="text-xs font-mono text-muted uppercase">Equity</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[#fafafa] text-slate-900 font-sans selection:bg-blue-100 selection:text-blue-900">
      {/* ---- Vertical Sidebar (wide screens) ---- */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        {/* Brand */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900">
            <TrendingUp className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-slate-900 font-sans">
                Trade<span className="text-muted">xa</span>
              </span>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-muted border border-slate-200">
                PRO 2.0
              </span>
            </div>
            <p className="text-xs text-muted font-mono">Stock Intelligence</p>
          </div>
        </div>

        {/* Nav items — stacked, active = solid slate-900 pill */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-3">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                id={`tab-${item.id}`}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium cursor-pointer transition-all text-left ${
                  isActive
                    ? 'bg-accent text-white shadow-sm'
                    : 'text-muted hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-white' : 'text-muted'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Quick tickers — sidebar bottom */}
        <div className="border-t border-slate-100 px-3 py-3">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Quick Tickers</div>
          <div className="flex flex-wrap gap-1.5">
            {quickTickers.map((t) => (
              <button
                key={t}
                onClick={() => onSelectSymbol(t)}
                className={`px-2 py-0.5 text-xs font-mono rounded border transition-colors tabular-nums ${
                  selectedSymbol === t
                    ? 'bg-accent text-white font-semibold border-accent'
                    : 'bg-white text-muted hover:text-slate-900 hover:border-slate-300 border-slate-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* ---- Right column: slim top strip, top bar, content ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Slim ticker strip above the content area */}
        <div className="sticky top-0 z-40">{tickerTape}</div>

        {/* Top bar: search + AI models + active symbol */}
        <div className="sticky top-[33px] z-40 border-b border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-4 px-4 py-2">
            {/* Compact brand for narrow screens (sidebar hidden there) */}
            <div className="flex items-center gap-2 lg:hidden">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900">
                <TrendingUp className="h-4 w-4 text-white" />
              </div>
              <span className="text-base font-bold tracking-tight text-slate-900">
                Trade<span className="text-muted">xa</span>
              </span>
            </div>

            {searchBox}

            <div className="flex items-center gap-2">
              {onOpenAiModal && (
                <button
                  onClick={onOpenAiModal}
                  id="btn-ai-copilot"
                  type="button"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-xs font-medium transition"
                  title="Configure LLMs and Deep Financial AI"
                >
                  <Sparkles className="h-3.5 w-3.5 text-muted" />
                  <span className="hidden sm:inline">AI Models</span>
                </button>
              )}

              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-900">
                <span className="text-xs text-slate-300">Active:</span>
                <span className="font-mono font-bold text-sm text-white tracking-wide">{selectedSymbol}</span>
              </div>
            </div>
          </div>

          {/* Horizontal nav strip — auto-hide fallback below lg (~1024px) */}
          <nav className="flex space-x-1 overflow-x-auto no-scrollbar border-t border-slate-100 px-2 pt-1.5 pb-1.5 lg:hidden">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  id={`tab-mobile-${item.id}`}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs font-medium rounded-lg cursor-pointer transition-all ${
                    isActive
                      ? 'bg-accent text-white'
                      : 'text-muted hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${isActive ? 'text-white' : 'text-muted'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
