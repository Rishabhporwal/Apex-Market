'use client';

import React, { useState, useEffect } from 'react';
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  ShieldAlert,
  Layers,
  Newspaper,
  BrainCircuit,
  CheckCircle2,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { MetricHelp } from '@/components/ui/MetricHelp';

interface AiVerdict {
  symbol: string;
  name: string;
  price: number;
  asOf: number;
  verdict: {
    action: 'BUY' | 'HOLD' | 'NEUTRAL' | 'SELL';
    confidence: number;
    horizon: 'short' | 'swing' | 'long';
    summary: string;
  };
  levels: {
    target1?: number;
    target2?: number;
    stopLoss?: number;
    supports: number[];
    resistances: number[];
    sma20?: number;
    sma50?: number;
    sma200?: number;
    rsi14?: number;
  };
  drivers: {
    bullish: string[];
    bearish: string[];
    newsItems: { title: string; source: string; url?: string; sentiment: string; score: number }[];
  };
  strategy: { headline: string; entry?: string; plan: string[]; riskNote: string };
  fundamentals?: {
    revenueGrowthYoY?: number;
    netMargin?: number;
    roe?: number;
    peRatio?: number;
    source: string;
  };
  technicals: { trend: string; rsi14?: number; sentimentScore?: number };
  aiNarrative?: string;
  disclaimer: string;
}

const ACTION_STYLES: Record<string, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
  BUY: { bg: 'bg-emerald-500/15 border-emerald-500/40', text: 'text-emerald-400', icon: <TrendingUp className="h-8 w-8" />, label: 'Buy' },
  HOLD: { bg: 'bg-amber-500/15 border-amber-500/40', text: 'text-amber-400', icon: <Minus className="h-8 w-8" />, label: 'Hold' },
  NEUTRAL: { bg: 'bg-slate-500/15 border-slate-500/40', text: 'text-slate-300', icon: <Minus className="h-8 w-8" />, label: 'Neutral' },
  SELL: { bg: 'bg-rose-500/15 border-rose-500/40', text: 'text-rose-400', icon: <TrendingDown className="h-8 w-8" />, label: 'Sell' },
};

function pct(n?: number | null, digits = 1) {
  return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** Visual price ladder: stop → price → targets with support/resistance ticks. */
function LevelLadder({ v }: { v: AiVerdict }) {
  const lv = v.levels;
  const nums = [
    lv.stopLoss,
    ...lv.supports,
    v.price,
    ...lv.resistances,
    lv.target1,
    lv.target2,
  ].filter((n): n is number => typeof n === 'number' && n > 0);
  if (!nums.length) return null;
  const lo = Math.min(...nums) * 0.995;
  const hi = Math.max(...nums) * 1.005;
  const pos = (x: number) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100))}%`;

  return (
    <div className="mt-2 px-1">
      <div className="relative h-14">
        {/* baseline */}
        <div className="absolute left-0 right-0 top-7 h-px bg-slate-700" />
        {/* stop */}
        {lv.stopLoss && (
          <Marker label={`Stop $${lv.stopLoss.toFixed(2)}`} left={pos(lv.stopLoss)} color="text-rose-400" sub="exit if price falls here" icon={<ShieldAlert className="h-3 w-3" />} />
        )}
        {/* supports */}
        {lv.supports.map((s, i) => (
          <Tick key={`s${i}`} left={pos(s)} color="bg-rose-500/50" label={`Support ${s.toFixed(2)}`} tip="support" />
        ))}
        {/* resistances */}
        {lv.resistances.map((r, i) => (
          <Tick key={`r${i}`} left={pos(r)} color="bg-amber-500/50" label={`Resistance ${r.toFixed(2)}`} tip="resistance" />
        ))}
        {/* current price */}
        <Marker label={`Now $${v.price.toFixed(2)}`} left={pos(v.price)} color="text-white" sub="current price" icon={<span className="h-2 w-2 rounded-full bg-white inline-block" />} center />
        {/* targets */}
        {lv.target1 && (
          <Marker label={`Target $${lv.target1.toFixed(2)}`} left={pos(lv.target1)} color="text-emerald-400" sub="first goal" icon={<Target className="h-3 w-3" />} />
        )}
        {lv.target2 && (
          <Marker label={`$${lv.target2.toFixed(2)}`} left={pos(lv.target2)} color="text-emerald-400" sub="stretch goal" />
        )}
      </div>
    </div>
  );
}

function Marker({ label, left, color, sub, icon, center }: { label: string; left: string; color: string; sub?: string; icon?: React.ReactNode; center?: boolean }) {
  return (
    <div className="absolute top-0 -translate-x-1/2 flex flex-col items-center" style={{ left }}>
      <span className={`text-[10px] font-semibold ${color} flex items-center gap-0.5 whitespace-nowrap`}>
        {icon} {label}
      </span>
      <span className={`h-3 w-px ${center ? 'bg-white' : 'bg-slate-500'}`} />
      {sub && <span className="text-[9px] text-slate-500 whitespace-nowrap">{sub}</span>}
    </div>
  );
}

function Tick({ left, color, label, tip }: { left: string; color: string; label: string; tip: string }) {
  return (
    <div className="absolute top-6 -translate-x-1/2 group/t" style={{ left }}>
      <span className={`block h-3 w-1.5 rounded-sm ${color}`} title={label} />
      <span className="pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover/t:block text-[9px] text-slate-400 whitespace-nowrap">
        {tip}
      </span>
    </div>
  );
}

export function VerdictView({ symbol }: { symbol: string }) {
  const [v, setV] = useState<AiVerdict | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/verdict?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) throw new Error((await res.json())?.error || `Failed (${res.status})`);
      setV(await res.json());
    } catch (e: any) {
      setError(e.message || 'Failed to generate verdict');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-10 text-center">
        <BrainCircuit className="h-10 w-10 mx-auto text-cyan-400 animate-pulse mb-4" />
        <div className="text-white font-semibold">AI is researching {symbol}…</div>
        <div className="text-xs text-slate-500 mt-1">Reading SEC filings, charts and news, then forming a verdict</div>
      </div>
    );
  }

  if (error || !v) {
    return (
      <div className="glass-panel rounded-2xl p-10 text-center">
        <AlertTriangle className="h-8 w-8 mx-auto text-amber-400 mb-3" />
        <div className="text-white">{error ?? 'No verdict available'}</div>
        <button onClick={load} className="mt-4 px-4 py-2 rounded-lg bg-cyan-500/20 text-cyan-300 text-sm hover:bg-cyan-500/30">
          Try again
        </button>
      </div>
    );
  }

  const style = ACTION_STYLES[v.verdict.action] ?? ACTION_STYLES.NEUTRAL;

  return (
    <div className="space-y-5">
      {/* Header + verdict badge */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center gap-6">
          <div className="flex-1">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="font-bold text-cyan-300 text-sm">{v.symbol}</span>
              <span>·</span>
              <span>{v.name}</span>
            </div>
            <div className="flex items-baseline gap-3 mt-1">
              <span className="text-4xl font-bold text-white">${v.price.toFixed(2)}</span>
              <span className="text-sm text-slate-400">
                · {v.technicals.trend === 'up' ? 'trending up' : v.technicals.trend === 'down' ? 'trending down' : 'moving sideways'}
                <MetricHelp term="rsi14" />
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-300 max-w-xl leading-relaxed">{v.verdict.summary}</p>
          </div>

          {/* Verdict badge + confidence */}
          <div className={`rounded-2xl border ${style.bg} p-5 min-w-[220px] text-center`}>
            <div className={`flex items-center justify-center gap-2 ${style.text}`}>{style.icon}</div>
            <div className={`text-3xl font-bold mt-1 ${style.text}`}>{style.label}</div>
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">AI confidence</div>
              <div className="text-xl font-bold text-white">{Math.round(v.verdict.confidence)}%</div>
              <div className="h-1.5 rounded-full bg-slate-800 mt-1.5 overflow-hidden">
                <div className="h-full bg-cyan-400 rounded-full" style={{ width: `${v.verdict.confidence}%` }} />
              </div>
            </div>
            <div className="mt-2 text-[11px] text-slate-400 capitalize">Horizon: {v.verdict.horizon}-term</div>
          </div>
        </div>

        <LevelLadder v={v} />
      </div>

      {/* Levels grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <LevelCard label="Target" help="price" value={v.levels.target1} color="text-emerald-400" sub="where the AI thinks it can go" />
        <LevelCard label="Stop Loss" help="price" value={v.levels.stopLoss} color="text-rose-400" sub="exit point to cap the loss" />
        <LevelCard label="Support" help="price" value={v.levels.supports[0]} color="text-rose-300" sub="price tends to bounce here" />
        <LevelCard label="Resistance" help="price" value={v.levels.resistances[0]} color="text-amber-300" sub="price tends to stall here" />
      </div>

      {/* Strategy */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="font-bold text-white flex items-center gap-2">
          <Target className="h-4 w-4 text-cyan-400" /> Suggested strategy
        </h3>
        <p className="text-sm text-slate-300 mt-2">{v.strategy.headline}</p>
        {v.strategy.entry && (
          <div className="mt-3 text-sm"><span className="text-slate-400">Entry zone:</span> <span className="text-white">{v.strategy.entry}</span></div>
        )}
        <ul className="mt-3 space-y-2">
          {v.strategy.plan.map((p, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-300">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" /> {p}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 shrink-0" /> <span>{v.strategy.riskNote}</span>
        </div>
      </div>

      {/* Drivers: fundamentals / technicals / news */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-white flex items-center gap-2 mb-3">
            <ChevronUp className="h-4 w-4 text-emerald-400" /> What's working
          </h3>
          <ul className="space-y-2">
            {(v.drivers.bullish.length ? v.drivers.bullish : ['No strong positives detected from current data.']).map((b, i) => (
              <li key={i} className="text-sm text-slate-300 flex gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />{b}</li>
            ))}
          </ul>
          {v.fundamentals && (
            <div className="mt-4 pt-4 border-t border-slate-800 grid grid-cols-2 gap-3 text-xs">
              <FundStat label="Sales growth" help="revenueGrowthYoY" value={pct(v.fundamentals.revenueGrowthYoY)} />
              <FundStat label="Profit margin" help="netMargin" value={v.fundamentals.netMargin != null ? `${v.fundamentals.netMargin.toFixed(1)}%` : '—'} />
              <FundStat label="Efficiency (ROE)" help="roe" value={v.fundamentals.roe != null ? `${v.fundamentals.roe.toFixed(1)}%` : '—'} />
              <FundStat label="P/E" help="peRatio" value={v.fundamentals.peRatio?.toFixed(1) ?? '—'} />
              <div className="col-span-2 text-[10px] text-slate-500">Source: {v.fundamentals.source}</div>
            </div>
          )}
        </div>

        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-white flex items-center gap-2 mb-3">
            <ChevronDown className="h-4 w-4 text-rose-400" /> What's worrying
          </h3>
          <ul className="space-y-2">
            {(v.drivers.bearish.length ? v.drivers.bearish : ['No strong negatives detected from current data.']).map((b, i) => (
              <li key={i} className="text-sm text-slate-300 flex gap-2"><AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />{b}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* News */}
      {v.drivers.newsItems?.length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-white flex items-center gap-2 mb-3">
            <Newspaper className="h-4 w-4 text-cyan-400" /> News the AI weighed
            <MetricHelp term="sentimentScore" />
          </h3>
          <div className="space-y-2">
            {v.drivers.newsItems.map((n, i) => (
              <div key={i} className="flex items-start gap-3 text-sm py-1.5 border-b border-slate-800/60 last:border-0">
                <span
                  className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                    n.sentiment === 'bullish'
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : n.sentiment === 'bearish'
                        ? 'bg-rose-500/15 text-rose-400'
                        : 'bg-slate-500/15 text-slate-400'
                  }`}
                >
                  {n.sentiment}
                </span>
                <div className="min-w-0">
                  {n.url ? (
                    <a href={n.url} target="_blank" rel="noreferrer" className="text-slate-200 hover:text-cyan-300 line-clamp-2">
                      {n.title}
                    </a>
                  ) : (
                    <span className="text-slate-200 line-clamp-2">{n.title}</span>
                  )}
                  <span className="text-[10px] text-slate-500 ml-2">{n.source}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI narrative (only when an LLM key is configured) */}
      {v.aiNarrative && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-white flex items-center gap-2 mb-3">
            <BrainCircuit className="h-4 w-4 text-cyan-400" /> AI deep analysis
          </h3>
          <div className="text-sm text-slate-300 leading-relaxed space-y-2">
            {v.aiNarrative.split('\n').map((line, i) => {
              const t = line.trim();
              if (!t) return <div key={i} className="h-1" />;
              // Headings (##, #)
              if (/^#{1,3}\s/.test(t))
                return (
                  <h4 key={i} className="font-bold text-white pt-2 pb-1">
                    {t.replace(/^#{1,3}\s*/, '')}
                  </h4>
                );
              // Bold via **...**
              const parts = t.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
              return (
                <p key={i}>
                  {parts.map((part, j) =>
                    part.startsWith('**') && part.endsWith('**') ? (
                      <strong key={j} className="text-white font-semibold">{part.slice(2, -2)}</strong>
                    ) : (
                      <span key={j}>{part}</span>
                    )
                  )}
                </p>
              );
            })}
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <div className="text-[11px] text-slate-500 leading-relaxed px-1">
        <ShieldAlert className="h-3 w-3 inline mr-1 -mt-0.5" />
        {v.disclaimer}
      </div>
    </div>
  );
}

function LevelCard({ label, value, color, sub, help }: { label: string; value?: number; color: string; sub: string; help: string }) {
  return (
    <div className="glass-panel rounded-xl p-4">
      <div className="text-[11px] uppercase tracking-wider text-slate-400 flex items-center gap-1">
        {label} <MetricHelp term={help} />
      </div>
      <div className={`text-2xl font-bold mt-1 ${value != null ? color : 'text-slate-600'}`}>
        {value != null ? `$${value.toFixed(2)}` : '—'}
      </div>
      <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>
    </div>
  );
}

function FundStat({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div>
      <div className="text-slate-500 flex items-center gap-1">{label} <MetricHelp term={help} /></div>
      <div className="text-slate-200 font-semibold">{value}</div>
    </div>
  );
}
