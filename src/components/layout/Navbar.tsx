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
  Star
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
    { id: 'discover', label: '🏠 Discover', icon: Compass },
    { id: 'prediction', label: '🤖 AI Verdict', icon: Target },
    { id: 'chart', label: 'Terminal & Chart', icon: Activity },
    { id: 'sentiment', label: 'News & AI Predictions', icon: Sparkles },
    { id: 'financials', label: 'Financials & Valuation', icon: BarChart2 },
    { id: 'filings', label: 'SEC Filings & Calls', icon: FileText },
    { id: 'screener', label: 'Stock Screener', icon: Sliders },
    { id: 'backtest', label: 'Quant Backtester', icon: Zap },
    { id: 'portfolio', label: 'Paper Trading', icon: Briefcase },
    { id: 'watchlist', label: '⭐ Watchlist', icon: Star },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-slate-800/80 bg-[#070b12]/90 backdrop-blur-md">
      {/* Index Ticker Tape Banner */}
      <div className="border-b border-slate-800/50 bg-[#090e18]/80 px-4 py-1.5 text-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between overflow-x-auto gap-6 no-scrollbar">
          <div className="flex items-center gap-2 text-slate-400 font-mono shrink-0">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">Market Pulse</span>
          </div>

          <div className="flex items-center gap-6 text-xs font-mono shrink-0">
            {indices.length > 0 ? (
              indices.map((idx) => {
                const isPos = idx.changePercent >= 0;
                const cleanName = idx.symbol === '^GSPC' ? 'S&P 500' : idx.symbol === '^IXIC' ? 'NASDAQ' : idx.symbol === '^DJI' ? 'DOW' : 'RUSSELL 2K';
                return (
                  <div key={idx.symbol} className="flex items-center gap-2">
                    <span className="font-medium text-slate-400">{cleanName}</span>
                    <span className="text-slate-200">{idx.price.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                    <span className={`flex items-center text-[11px] font-semibold ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPos ? <ArrowUpRight className="h-3 w-3 mr-0.5" /> : <ArrowDownRight className="h-3 w-3 mr-0.5" />}
                      {isPos ? '+' : ''}{idx.changePercent.toFixed(2)}%
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="flex items-center gap-6 text-slate-500">
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
                  className={`px-2 py-0.5 text-[11px] font-mono rounded transition-colors ${
                    selectedSymbol === t
                      ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/40'
                      : 'bg-slate-800/60 text-slate-400 hover:text-slate-200 hover:bg-slate-700/60'
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
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-cyan-600 via-blue-600 to-indigo-600 shadow-lg shadow-cyan-500/20">
            <TrendingUp className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-white font-sans">
                Apex<span className="text-cyan-400">Market</span>
              </span>
              <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-400 border border-cyan-500/20">
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
              className="w-full rounded-lg border border-slate-700/80 bg-slate-900/90 pl-9 pr-20 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none transition focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/20 font-mono"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-slate-700">
                ↵ Enter
              </span>
            </div>
          </div>

          {/* Autocomplete Dropdown */}
          {searchResults.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-lg border border-slate-700 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
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
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-slate-800/80 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-cyan-400">{item.symbol}</span>
                    <span className="text-xs text-slate-300 truncate max-w-[220px]">{item.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 uppercase">Equity</span>
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500/20 to-indigo-500/20 hover:from-cyan-500/30 hover:to-indigo-500/30 text-cyan-300 border border-cyan-500/30 text-xs font-mono font-bold transition shadow-sm"
              title="Configure LLMs and Deep Financial AI"
            >
              <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
              <span>AI Models</span>
            </button>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/70">
            <span className="text-xs text-slate-400">Active:</span>
            <span className="font-mono font-bold text-sm text-cyan-300 tracking-wide">{selectedSymbol}</span>
          </div>
        </div>
      </div>

      {/* Primary Feature Tabs */}
      <div className="mx-auto max-w-7xl px-4">
        <nav className="flex space-x-1 overflow-x-auto no-scrollbar border-t border-slate-800/60 pt-1 pb-1">
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
                    ? 'bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-300 border border-cyan-500/30 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-cyan-400' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
