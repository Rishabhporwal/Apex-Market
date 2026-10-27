'use client';

import React, { useState, useEffect } from 'react';
import { 
  Sliders, 
  Search, 
  Sparkles, 
  ArrowUpRight, 
  ArrowDownRight, 
  Filter, 
  RefreshCw,
  TrendingUp,
  Layers,
  ChevronRight
} from 'lucide-react';
import { ScreenerFilter, ScreenerStockResult } from '@/types';
import { MetricHelp } from '@/components/ui/MetricHelp';

interface ScreenerViewProps {
  onSelectSymbol: (symbol: string) => void;
}

export function ScreenerView({ onSelectSymbol }: ScreenerViewProps) {
  const [results, setResults] = useState<ScreenerStockResult[]>([]);
  const [loading, setLoading] = useState(true);
  // Simple mode: plain-English filters for non-technical users. Advanced = original UI.
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  // Simple-mode picks (all optional, plain-language)
  const [simpleGrowth, setSimpleGrowth] = useState<string>('any'); // any | growing | fast
  const [simpleProfit, setSimpleProfit] = useState<string>('any'); // any | profitable | very
  const [simpleCheap, setSimpleCheap] = useState<string>('any'); // any | cheap | reasonable

  // Filters State
  const [sector, setSector] = useState<string>('ALL');
  const [minPE, setMinPE] = useState<number | undefined>(undefined);
  const [maxPE, setMaxPE] = useState<number | undefined>(undefined);
  const [minMarketCap, setMinMarketCap] = useState<number | undefined>(undefined);
  const [minSentiment, setMinSentiment] = useState<number>(0);
  const [pricePerformance, setPricePerformance] = useState<ScreenerFilter['pricePerformance']>('ALL');
  const [sortBy, setSortBy] = useState<ScreenerFilter['sortBy']>('marketCap');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Active preset
  const [activePreset, setActivePreset] = useState<string>('ALL');

  const fetchScreenerData = async (customFilter?: ScreenerFilter) => {
    setLoading(true);
    try {
      const payload: ScreenerFilter = customFilter || {
        sector: sector === 'ALL' ? undefined : sector,
        minPE,
        maxPE,
        minMarketCap,
        minSentimentScore: minSentiment > 0 ? minSentiment : undefined,
        pricePerformance,
        sortBy,
        sortOrder,
        // Simple-mode plain-English filters
        ...(mode === 'simple'
          ? {
              minRevenueGrowth: simpleGrowth === 'growing' ? 5 : simpleGrowth === 'fast' ? 15 : undefined,
              minNetMargin: simpleProfit === 'profitable' ? 5 : simpleProfit === 'very' ? 15 : undefined,
              maxPE: simpleCheap !== 'any' ? Math.min(maxPE ?? Infinity, simpleCheap === 'cheap' ? 15 : 25) : maxPE,
            }
          : {}),
      };

      const res = await fetch('/api/screener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        setResults(data);
      }
    } catch (err) {
      console.error('Screener fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScreenerData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sector, minMarketCap, minPE, maxPE, minSentiment, pricePerformance, sortBy, sortOrder, mode, simpleGrowth, simpleProfit, simpleCheap]);

  const applyPreset = (presetName: string) => {
    setActivePreset(presetName);
    if (presetName === 'TECH_GROWTH') {
      setSector('Technology');
      setMinMarketCap(100e9);
      setMinSentiment(20);
      setPricePerformance('ALL');
    } else if (presetName === 'HIGH_SENTIMENT') {
      setSector('ALL');
      setMinSentiment(40);
      setPricePerformance('GAINER_TODAY');
    } else if (presetName === 'VALUE_DIVIDENDS') {
      setSector('ALL');
      setMaxPE(25);
      setMinSentiment(0);
      setPricePerformance('ALL');
    } else if (presetName === 'NEAR_HIGHS') {
      setSector('ALL');
      setMinSentiment(10);
      setPricePerformance('NEAR_52W_HIGH');
    } else {
      setSector('ALL');
      setMinPE(undefined);
      setMaxPE(undefined);
      setMinMarketCap(undefined);
      setMinSentiment(0);
      setPricePerformance('ALL');
    }
  };

  const formatCap = (cap: number) => {
    if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
    if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`;
    return `$${(cap / 1e6).toFixed(0)}M`;
  };

  return (
    <div className="space-y-6">
      {/* Presets Bar */}
      <div className="glass-panel rounded-2xl p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-200 pb-4 mb-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 font-sans flex items-center gap-2">
              <Sliders className="h-5 w-5 text-cyan-600" /> Professional Multi-Variable Stock Screener
            </h2>
            <p className="text-xs text-slate-500 font-mono mt-0.5">Filter across liquid US equities by valuation, technicals & AI sentiment scores</p>
          </div>

          <div className="flex items-center gap-2">
            {/* Simple / Advanced mode toggle */}
            <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs font-sans">
              <button
                onClick={() => setMode('simple')}
                className={`px-3 py-1.5 transition ${mode === 'simple' ? 'bg-cyan-50 text-cyan-700 font-semibold' : 'bg-white text-slate-500 hover:text-slate-900'}`}
              >
                😊 Simple
              </button>
              <button
                onClick={() => setMode('advanced')}
                className={`px-3 py-1.5 transition ${mode === 'advanced' ? 'bg-cyan-50 text-cyan-700 font-semibold' : 'bg-white text-slate-500 hover:text-slate-900'}`}
              >
                ⚙️ Advanced
              </button>
            </div>
            <button
              onClick={() => fetchScreenerData()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-xs font-mono text-cyan-600 transition"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Run Screen
            </button>
          </div>
        </div>

        {/* SIMPLE MODE: plain-English filters */}
        {mode === 'simple' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-sans text-sm">
            <div>
              <label className="block text-slate-400 font-medium mb-1.5">
                How should sales be growing? <MetricHelp term="revenueGrowthYoY" />
              </label>
              <select
                value={simpleGrowth}
                onChange={(e) => setSimpleGrowth(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-400 outline-none focus:border-cyan-500"
              >
                <option value="any">I don't mind</option>
                <option value="growing">Growing (5%+ a year)</option>
                <option value="fast">Growing fast (15%+ a year)</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1.5">
                How profitable should it be? <MetricHelp term="netMargin" />
              </label>
              <select
                value={simpleProfit}
                onChange={(e) => setSimpleProfit(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-400 outline-none focus:border-cyan-500"
              >
                <option value="any">I don't mind</option>
                <option value="profitable">Makes a profit</option>
                <option value="very">Very profitable (15%+ margins)</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-400 font-medium mb-1.5">
                How expensive should the price be? <MetricHelp term="peRatio" />
              </label>
              <select
                value={simpleCheap}
                onChange={(e) => setSimpleCheap(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-400 outline-none focus:border-cyan-500"
              >
                <option value="any">I don't mind</option>
                <option value="cheap">Cheap (P/E under 15)</option>
                <option value="reasonable">Reasonable (P/E under 25)</option>
              </select>
            </div>
          </div>
        )}

        {/* Preset Chips */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar font-mono text-xs">
          <span className="text-slate-500 text-[11px] uppercase mr-1">Curated Presets:</span>
          {[
            { id: 'ALL', label: 'All Equities' },
            { id: 'TECH_GROWTH', label: '🚀 AI & Tech Growth' },
            { id: 'HIGH_SENTIMENT', label: '🔥 High Sentiment Momentum' },
            { id: 'VALUE_DIVIDENDS', label: '💎 Undervalued & Cash Rich' },
            { id: 'NEAR_HIGHS', label: '⚡ 52-Week Breakouts' },
          ].map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className={`px-3 py-1.5 rounded-xl whitespace-nowrap transition ${
                activePreset === p.id
                  ? 'bg-cyan-50 text-cyan-700 font-bold border border-cyan-200'
                  : 'bg-white text-slate-500 hover:text-slate-900 border border-slate-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Interactive Filter Bar (Advanced mode only) */}
      <div
        className={`glass-panel rounded-2xl p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 font-mono text-xs ${mode === 'advanced' ? '' : 'hidden'}`}
        aria-hidden={mode !== 'advanced'}
      >
        {/* Sector */}
        <div>
          <label className="block text-slate-500 text-[11px] uppercase mb-1">Sector</label>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-400 outline-none focus:border-cyan-500"
          >
            <option value="ALL">All Sectors</option>
            <option value="Technology">Technology</option>
            <option value="Communication Services">Communication</option>
            <option value="Consumer Cyclical">Consumer Cyclical</option>
            <option value="Financial Services">Financial Services</option>
            <option value="Healthcare">Healthcare</option>
            <option value="Energy">Energy</option>
            <option value="Industrials">Industrials</option>
            <option value="Consumer Defensive">Consumer Defensive</option>
          </select>
        </div>

        {/* Min Market Cap */}
        <div>
          <label className="block text-slate-500 text-[11px] uppercase mb-1">Market Cap</label>
          <select
            value={minMarketCap || ''}
            onChange={(e) => setMinMarketCap(e.target.value ? Number(e.target.value) : undefined)}
            className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-400 outline-none focus:border-cyan-500"
          >
            <option value="">Any Market Cap</option>
            <option value="1000000000000">$1 Trillion+ (Mega)</option>
            <option value="200000000000">$200 Billion+ (Large)</option>
            <option value="50000000000">$50 Billion+ (Mid+)</option>
            <option value="10000000000">$10 Billion+ (Standard)</option>
          </select>
        </div>

        {/* Max P/E */}
        <div>
          <label className="block text-slate-500 text-[11px] uppercase mb-1">Valuation (P/E)</label>
          <select
            value={maxPE || ''}
            onChange={(e) => setMaxPE(e.target.value ? Number(e.target.value) : undefined)}
            className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-400 outline-none focus:border-cyan-500"
          >
            <option value="">Any P/E Multiple</option>
            <option value="20">Under 20x (Deep Value)</option>
            <option value="35">Under 35x (Reasonable)</option>
            <option value="50">Under 50x (Growth)</option>
          </select>
        </div>

        {/* Min Sentiment Score */}
        <div>
          <label className="block text-slate-500 text-[11px] uppercase mb-1">
            Min AI Sentiment: <strong className="text-cyan-600">+{minSentiment}</strong>
          </label>
          <input
            type="range"
            min="0"
            max="60"
            step="10"
            value={minSentiment}
            onChange={(e) => setMinSentiment(Number(e.target.value))}
            className="w-full accent-cyan-400 cursor-pointer mt-1"
          />
        </div>

        {/* Price Performance Filter */}
        <div>
          <label className="block text-slate-500 text-[11px] uppercase mb-1">Price Filter</label>
          <select
            value={pricePerformance}
            onChange={(e) => setPricePerformance(e.target.value as any)}
            className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-400 outline-none focus:border-cyan-500"
          >
            <option value="ALL">All Price Action</option>
            <option value="GAINER_TODAY">Today Gainers</option>
            <option value="LOSER_TODAY">Today Losers</option>
            <option value="NEAR_52W_HIGH">Within 5% of 52W High</option>
            <option value="NEAR_52W_LOW">Within 10% of 52W Low</option>
          </select>
        </div>
      </div>

      {/* Results Table */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs font-mono text-slate-500">
            Found <strong className="text-slate-900">{results.length}</strong> matching candidate stocks
          </div>
          <div className="text-xs font-mono text-slate-500">
            Click any row to open institutional terminal research
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-slate-500 font-mono">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-cyan-600" />
            Executing screening filters...
          </div>
        ) : results.length === 0 ? (
          <div className="py-16 text-center text-slate-500 font-mono">
            No stocks matched your active filter criteria. Try relaxing the limits or switching presets.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="pb-3 font-semibold">Ticker & Name</th>
                  <th className="pb-3 font-semibold">Sector</th>
                  <th className="pb-3 font-semibold">Price</th>
                  <th className="pb-3 font-semibold">Change %</th>
                  <th className="pb-3 font-semibold">Market Cap</th>
                  <th className="pb-3 font-semibold">P/E</th>
                  <th className="pb-3 font-semibold">Div Yield</th>
                  <th className="pb-3 font-semibold">RSI 14</th>
                  <th className="pb-3 font-semibold">AI Sentiment</th>
                  <th className="pb-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {results.map((stk) => {
                  const isPos = stk.changePercent >= 0;
                  return (
                    <tr
                      key={stk.symbol}
                      onClick={() => onSelectSymbol(stk.symbol)}
                      className="hover:bg-slate-50 transition cursor-pointer group"
                    >
                      <td className="py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-cyan-700 text-sm group-hover:text-cyan-600">
                            {stk.symbol}
                          </span>
                          <span className="text-[11px] text-slate-500 font-sans truncate max-w-[150px]">
                            {stk.name}
                          </span>
                        </div>
                      </td>

                      <td className="py-3.5 text-slate-500">{stk.sector}</td>

                      <td className="py-3.5 font-bold text-slate-900">${stk.price.toFixed(2)}</td>

                      <td className="py-3.5">
                        <span
                          className={`inline-flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded ${
                            isPos
                              ? 'bg-emerald-50 text-emerald-600'
                              : 'bg-rose-50 text-rose-600'
                          }`}
                        >
                          {isPos ? '+' : ''}
                          {stk.changePercent.toFixed(2)}%
                        </span>
                      </td>

                      <td className="py-3.5 text-slate-400">{formatCap(stk.marketCap)}</td>

                      <td className="py-3.5 text-slate-400">{stk.peRatio ? stk.peRatio.toFixed(1) : 'N/A'}</td>

                      <td className="py-3.5 text-slate-500">
                        {stk.dividendYield ? `${stk.dividendYield.toFixed(1)}%` : '0.0%'}
                      </td>

                      <td className="py-3.5">
                        <span className={`px-1.5 py-0.5 rounded text-[11px] ${
                          (stk.rsi14 || 50) >= 70 ? 'bg-rose-50 text-rose-600' :
                          (stk.rsi14 || 50) <= 30 ? 'bg-emerald-50 text-emerald-600' :
                          'text-slate-400'
                        }`}>
                          {stk.rsi14 || 50}
                        </span>
                      </td>

                      <td className="py-3.5">
                        <span className={`font-bold ${stk.sentimentScore >= 20 ? 'text-emerald-600' : stk.sentimentScore <= -20 ? 'text-rose-600' : 'text-slate-500'}`}>
                          {stk.sentimentScore > 0 ? `+${stk.sentimentScore}` : stk.sentimentScore} ({stk.sentimentLabel})
                        </span>
                      </td>

                      <td className="py-3.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectSymbol(stk.symbol);
                          }}
                          className="px-2.5 py-1 rounded bg-slate-50 hover:bg-cyan-100 text-cyan-600 text-xs font-semibold transition"
                        >
                          Research ›
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
    </div>
  );
}
