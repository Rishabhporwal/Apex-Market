'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  Sparkles,
  ChevronRight,
  RefreshCw,
  TrendingUp,
  Shield,
  DollarSign,
  Landmark,
  Building2,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { MetricHelp, plainEnglishSummary } from '@/components/ui/MetricHelp';

/** Row shape the screener API returns (fundamentals come from SEC EDGAR). */
export interface ScreenerRow {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  marketCap: number;
  peRatio?: number | null;
  dividendYield?: number | null;
  volume?: number;
  revenueGrowthYoY?: number | null;
  netMargin?: number | null;
  roe?: number | null;
  fiscal_year?: number | null;
  source?: string;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  icon?: string;
}

const FALLBACK_PRESETS: Preset[] = [
  { id: 'quality', name: 'Steady Growers', description: 'Profitable companies growing sales 10%+ a year' },
  { id: 'value', name: 'Cheap & Profitable', description: 'Low price relative to profits, solid margins' },
  { id: 'dividend', name: 'Dividend Payers', description: 'Reliable income paid to you, every year' },
  { id: 'mega', name: 'Big & Stable', description: 'The largest, most established companies' },
];

const PRESET_ICONS: Record<string, React.ReactNode> = {
  quality: <Sparkles className="h-5 w-5 text-emerald-600" />,
  value: <DollarSign className="h-5 w-5 text-amber-600" />,
  dividend: <Landmark className="h-5 w-5 text-cyan-600" />,
  mega: <Building2 className="h-5 w-5 text-indigo-600" />,
};

function formatCap(cap: number | null | undefined): string {
  if (!cap) return '—';
  if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T`;
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`;
  return `$${(cap / 1e6).toFixed(0)}M`;
}

interface DiscoverViewProps {
  onSelectSymbol: (symbol: string) => void;
}

export function DiscoverView({ onSelectSymbol }: DiscoverViewProps) {
  const [presets, setPresets] = useState<Preset[]>(FALLBACK_PRESETS);
  const [activePreset, setActivePreset] = useState<string>('quality');
  const [results, setResults] = useState<ScreenerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [suggestions, setSuggestions] = useState<{ symbol: string; name: string }[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  // Load available presets from the API (falls back to the static list).
  useEffect(() => {
    fetch('/api/screener?presets=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.presets) && d.presets.length) setPresets(d.presets);
      })
      .catch(() => {});
  }, []);

  const runPreset = useCallback(async (id: string) => {
    setActivePreset(id);
    setSearch('');
    setSearchOpen(false);
    setLoading(true);
    try {
      const res = await fetch(`/api/screener?preset=${id}`);
      if (res.ok) {
        const data = await res.json();
        // gateway envelope: {warehouseReady, count, filters, results}
        setResults(Array.isArray(data) ? data : (data.results ?? []));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runPreset('quality');
  }, [runPreset]);

  // Live search with autocomplete
  const onSearchChange = (q: string) => {
    setSearch(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 1) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/screener?search=${encodeURIComponent(q)}&limit=8`);
        if (res.ok) {
          const data = await res.json();
          setSuggestions(
            (Array.isArray(data) ? data : (data.results ?? [])).map((r: ScreenerRow) => ({
              symbol: r.symbol,
              name: r.name,
            }))
          );
          setSearchOpen(true);
        }
      } catch {}
    }, 200);
  };

  // Click outside closes suggestions
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const active = presets.find((p) => p.id === activePreset);

  return (
    <div className="space-y-6">
      {/* Hero: what is this? */}
      <div className="glass-panel rounded-2xl p-6 sm:p-8">
        <div className="max-w-2xl">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 font-sans">
            Research real companies — <span className="text-cyan-600">in plain English</span>
          </h1>
          <p className="mt-2 text-sm text-slate-500 leading-relaxed">
            Every number below comes straight from the companies’ own filings with the SEC — the same official
            reports professionals read. No jargon, no ads, no accounts. Hover over any{' '}
            <span className="inline-block align-middle">
              <MetricHelp term="peRatio" />
            </span>{' '}
            symbol to see what it means.
          </p>
        </div>

        {/* Search */}
        <div ref={searchBoxRef} className="relative mt-6 max-w-xl">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onFocus={() => suggestions.length && setSearchOpen(true)}
            placeholder="Search any company — try “Apple” or “coffee”"
            className="w-full bg-white border border-slate-300 focus:border-cyan-500 rounded-xl pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-500 outline-none transition"
          />
          {searchOpen && suggestions.length > 0 && (
            <div className="absolute z-40 mt-2 w-full rounded-xl bg-white border border-slate-300 shadow-lg overflow-hidden">
              {suggestions.map((s) => (
                <button
                  key={s.symbol}
                  onClick={() => onSelectSymbol(s.symbol)}
                  className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center justify-between text-sm"
                >
                  <span className="font-bold text-cyan-700">{s.symbol}</span>
                  <span className="text-slate-500 text-xs truncate max-w-[70%]">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Preset cards */}
      <div>
        <h2 className="text-sm font-semibold text-slate-400 mb-3 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-cyan-600" /> Start with a question
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {presets.map((p) => (
            <button
              key={p.id}
              onClick={() => runPreset(p.id)}
              className={`text-left rounded-2xl p-4 border transition group ${
                activePreset === p.id
                  ? 'bg-cyan-50 border-cyan-200'
                  : 'glass-panel border-transparent hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between">
                {PRESET_ICONS[p.id] ?? <Sparkles className="h-5 w-5 text-cyan-600" />}
                {activePreset === p.id && (
                  <span className="text-[10px] font-mono text-cyan-600 uppercase tracking-wider">Showing</span>
                )}
              </div>
              <div className="mt-3 font-bold text-slate-900 text-sm group-hover:text-cyan-700 transition">{p.name}</div>
              <div className="mt-1 text-xs text-slate-500 leading-relaxed">{p.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="glass-panel rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-bold text-slate-900">
              {active?.name ?? 'Results'}{' '}
              <span className="text-slate-500 font-normal text-sm">
                ({loading ? '…' : `${results.length} companies`})
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {active?.description ?? ''} · ranked by size · click a company to open its full research page
            </p>
          </div>
        </div>

        {loading ? (
          <div className="py-16 text-center text-slate-500 font-sans">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-3 text-cyan-600" />
            <span className="text-sm">Reading SEC filings…</span>
          </div>
        ) : results.length === 0 ? (
          <div className="py-16 text-center text-slate-500 font-sans text-sm">
            Nothing matched. Try another starting point above.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {results.map((s) => {
              const isPos = (s.changePercent ?? 0) >= 0;
              return (
                <button
                  key={s.symbol}
                  onClick={() => onSelectSymbol(s.symbol)}
                  className="text-left rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-50 hover:border-cyan-200 p-4 transition group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-cyan-700">{s.symbol}</span>
                        <span className="text-xs text-slate-500 truncate">{s.sector}</span>
                      </div>
                      <div className="text-sm text-slate-900 font-medium truncate mt-0.5">{s.name}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-slate-900">${s.price?.toFixed(2)}</div>
                      <div
                        className={`text-xs font-semibold flex items-center justify-end gap-0.5 ${
                          isPos ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {isPos ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                        {isPos ? '+' : ''}
                        {(s.changePercent ?? 0).toFixed(2)}%
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 text-xs text-slate-400 leading-relaxed border-l-2 border-cyan-200 pl-2.5">
                    {plainEnglishSummary(s)}
                  </p>

                  <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      P/E <MetricHelp term="peRatio" />
                      <strong className="text-slate-400">{s.peRatio ? s.peRatio.toFixed(1) : '—'}</strong>
                    </span>
                    <span className="flex items-center gap-1">
                      Growth <MetricHelp term="revenueGrowthYoY" />
                      <strong className={s.revenueGrowthYoY != null && s.revenueGrowthYoY >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                        {s.revenueGrowthYoY != null ? `${s.revenueGrowthYoY.toFixed(1)}%` : '—'}
                      </strong>
                    </span>
                    <span className="flex items-center gap-1">
                      Size <MetricHelp term="marketCap" />
                      <strong className="text-slate-400">{formatCap(s.marketCap)}</strong>
                    </span>
                  </div>

                  <div className="mt-3 pt-3 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-500">
                    <span>
                      Data: {s.fiscal_year ? `FY${s.fiscal_year} SEC filing` : 'SEC filing'}
                      {s.source === 'edgar+yahoo' ? ' + live price' : ''}
                    </span>
                    <span className="flex items-center gap-1 text-cyan-600 opacity-0 group-hover:opacity-100 transition">
                      Research <ChevronRight className="h-3 w-3" />
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
