'use client';

import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  Search,
  Activity,
  BarChart2,
  PieChart,
  FileText,
  Sliders,
  Zap,
  Briefcase,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  Target,
  Compass,
  Star,
  Trophy
} from 'lucide-react';
import { StockQuote } from '@/types';

interface NavbarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onOpenAiModal?: () => void;
}

export function Navbar({ activeTab, setActiveTab, selectedSymbol, onSelectSymbol, onOpenAiModal }: NavbarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ symbol: string; name: string }>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [indices, setIndices] = useState<StockQuote[]>([]);

  // Popular quick tickers
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
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white">
      {/* Index Ticker Tape Banner */}
      <div className="border-b border-slate-100 bg-[#fafafa] px-4 py-1.5 text-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between overflow-x-auto gap-6 no-scrollbar">
          <div className="flex items-center gap-2 text-slate-500 font-mono shrink-0">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Market Pulse</span>
          </div>

          <div className="flex items-center gap-6 text-xs font-mono shrink-0 tabular-nums">
            {indices.length > 0 ? (
              indices.map((idx) => {
                const isPos = idx.changePercent >= 0;
                const cleanName = idx.symbol === '^GSPC' ? 'S&P 500' : idx.symbol === '^IXIC' ? 'NASDAQ' : idx.symbol === '^DJI' ? 'DOW' : 'RUSSELL 2K';
                return (
                  <div key={idx.symbol} className="flex items-center gap-2">
                    <span className="font-medium text-slate-400">{cleanName}</span>
                    <span className="text-slate-700">{idx.price.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                    <span className={`flex items-center text-[11px] font-semibold ${isPos ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {isPos ? <ArrowUpRight className="h-3 w-3 mr-0.5" /> : <ArrowDownRight className="h-3 w-3 mr-0.5" />}
                      {isPos ? '+' : ''}{idx.changePercent.toFixed(2)}%
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="flex items-center gap-6 text-slate-400">
                <span>S&P 500: 5,864.6 (+0.40%)</span>
                <span>NASDAQ: 18,374.8 (+0.63%)</span>
                <span>DOW: 43,275.9 (+0.09%)</span>
                <span>10Y YIELD: 4.08% (-0.02)</span>
              </div>
            )}
          </div>

          <div className="hidden lg:flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-slate-400 font-mono">Quick Tickers:</span>
            <div className="flex gap-1.5">
              {quickTickers.map((t) => (
                <button
                  key={t}
                  onClick={() => onSelectSymbol(t)}
                  className={`px-2 py-0.5 text-[11px] font-mono rounded border transition-colors tabular-nums ${
                    selectedSymbol === t
                      ? 'bg-slate-900 text-white font-semibold border-slate-900'
                      : 'bg-white text-slate-500 hover:text-slate-900 hover:border-slate-300 border-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main Navigation Bar */}
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 gap-4">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900">
            <TrendingUp className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-slate-900 font-sans">
                Trade<span className="text-slate-400">xa</span>
              </span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500 border border-slate-200">
                PRO 2.0
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-mono hidden sm:block">Modular Stock Intelligence Platform</p>
          </div>
        </div>

        {/* Global Symbol Search with dropdown */}
        <div className="relative flex-1 max-w-md">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder={`Search ticker or company (e.g. NVDA, Apple, TSLA)...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQuery.trim()) {
                  onSelectSymbol(searchQuery.trim().toUpperCase());
                  setSearchQuery('');
                  setSearchResults([]);
                }
              }}
              className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-20 py-2 text-sm text-slate-900 placeholder-slate-400 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 font-mono"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <span className="rounded bg-slate-50 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-slate-200">
                ↵ Enter
              </span>
            </div>
          </div>

          {/* Autocomplete Dropdown */}
          {searchResults.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2.5 py-1">
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
                    <span className="text-xs text-slate-500 truncate max-w-[220px]">{item.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 uppercase">Equity</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Current Active Symbol Badge & AI Model Settings */}
        <div className="flex items-center gap-2">
          {onOpenAiModal && (
            <button
              onClick={onOpenAiModal}
              id="btn-ai-copilot"
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 text-xs font-medium transition"
              title="Configure LLMs and Deep Financial AI"
            >
              <Sparkles className="h-3.5 w-3.5 text-slate-400" />
              <span>AI Models</span>
            </button>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-900">
            <span className="text-xs text-slate-400">Active:</span>
            <span className="font-mono font-bold text-sm text-white tracking-wide">{selectedSymbol}</span>
          </div>
        </div>
      </div>

      {/* Primary Feature Tabs */}
      <div className="mx-auto max-w-7xl px-4">
        <nav className="flex space-x-1 overflow-x-auto no-scrollbar border-t border-slate-100 pt-1.5 pb-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                id={`tab-${item.id}`}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-2 whitespace-nowrap px-3.5 py-2 text-xs font-medium rounded-lg cursor-pointer transition-all ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
