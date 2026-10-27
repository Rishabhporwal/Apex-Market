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
  Star,
  Pin,
  CalendarClock,
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
    atr14?: number;
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
  tradeWindow?: { horizon: string; holdingDays: number; validUntil: string; note: string } | null;
  earnings?: { earningsDate: string | null; daysUntil: number | null } | null;
  breakdown?: {
    trend: { points: number; detail: string };
    rsi: { points: number; detail: string };
    sentiment: { points: number; detail: string };
    fundamentals: { points: number; max: number; used: boolean; detail: string; factors: { name: string; value: string; points: number }[] };
    bearishVotes?: { count: number; reasons: string[] };
    score: number;
  };
  aiNarrative?: string;
  ensemble?: { consensus: string | null; agreeing: number; of: number; votes: { model: string; verdict: string | null; confidenceGuess: number | null; error?: string }[] } | null;
  disclaimer: string;
}

const ACTION_STYLES: Record<string, { bg: string; text: string; icon: React.ReactNode; label: string }> = {
  BUY: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-600', icon: <TrendingUp className="h-8 w-8" />, label: 'Buy' },
  HOLD: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-600', icon: <Minus className="h-8 w-8" />, label: 'Hold' },
  NEUTRAL: { bg: 'bg-slate-50 border-slate-200', text: 'text-slate-400', icon: <Minus className="h-8 w-8" />, label: 'Neutral' },
  SELL: { bg: 'bg-rose-50 border-rose-200', text: 'text-rose-600', icon: <TrendingDown className="h-8 w-8" />, label: 'Sell' },
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
        <div className="absolute left-0 right-0 top-7 h-px bg-slate-100" />
        {/* stop */}
        {lv.stopLoss && (
          <Marker label={`Stop $${lv.stopLoss.toFixed(2)}`} left={pos(lv.stopLoss)} color="text-rose-600" sub="exit if price falls here" icon={<ShieldAlert className="h-3 w-3" />} />
        )}
        {/* supports */}
        {lv.supports.map((s, i) => (
          <Tick key={`s${i}`} left={pos(s)} color="bg-rose-50" label={`Support ${s.toFixed(2)}`} tip="support" />
        ))}
        {/* resistances */}
        {lv.resistances.map((r, i) => (
          <Tick key={`r${i}`} left={pos(r)} color="bg-amber-50" label={`Resistance ${r.toFixed(2)}`} tip="resistance" />
        ))}
        {/* current price */}
        <Marker label={`Now $${v.price.toFixed(2)}`} left={pos(v.price)} color="text-slate-900" sub="current price" icon={<span className="h-2 w-2 rounded-full bg-white inline-block" />} center />
        {/* targets */}
        {lv.target1 && (
          <Marker label={`Target $${lv.target1.toFixed(2)}`} left={pos(lv.target1)} color="text-emerald-600" sub="first goal" icon={<Target className="h-3 w-3" />} />
        )}
        {lv.target2 && (
          <Marker label={`$${lv.target2.toFixed(2)}`} left={pos(lv.target2)} color="text-emerald-600" sub="stretch goal" />
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
      <span className="pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover/t:block text-[9px] text-slate-500 whitespace-nowrap">
        {tip}
      </span>
    </div>
  );
}

/** Drill-down: the per-component receipts behind the verdict score. */
function ScoreBreakdown({ breakdown, action }: { breakdown: NonNullable<AiVerdict['breakdown']>; action: string }) {
  const [open, setOpen] = useState(false);
  const total = breakdown.score ?? breakdown.trend.points + breakdown.rsi.points + breakdown.sentiment.points + breakdown.fundamentals.points;
  const rows: { key: string; label: string; points: number; detail: string }[] = [
    { key: 'trend', label: 'Trend alignment', points: breakdown.trend.points, detail: breakdown.trend.detail },
    { key: 'rsi', label: 'RSI position', points: breakdown.rsi.points, detail: breakdown.rsi.detail },
    { key: 'sentiment', label: 'News sentiment', points: breakdown.sentiment.points, detail: breakdown.sentiment.detail },
    { key: 'fundamentals', label: 'Fundamental quality', points: breakdown.fundamentals.points, detail: breakdown.fundamentals.detail },
  ];
  const ptsClass = (p: number) => (p > 0 ? 'text-emerald-600' : p < 0 ? 'text-rose-600' : 'text-slate-500');
  return (
    <div className="glass-panel rounded-2xl p-6">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left group">
        <h3 className="font-bold text-slate-900 flex items-center gap-2">
          <BrainCircuit className="h-4 w-4 text-cyan-600" /> Why this verdict?
          <span className="text-[10px] font-normal text-slate-500 hidden sm:inline">— the receipts behind every point</span>
        </h3>
        <span className="flex items-center gap-2">
          <span className={`text-xs font-semibold ${ptsClass(total)}`}>{total > 0 ? '+' : ''}{total} score</span>
          {open ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500 group-hover:text-cyan-700" />}
        </span>
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          {rows.map((r) => (
            <div key={r.key} className="flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
              <span className={`shrink-0 min-w-[52px] text-center text-xs font-bold rounded-lg px-2 py-1 ${r.points > 0 ? 'bg-emerald-50 text-emerald-600' : r.points < 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-500'}`}>
                {r.points > 0 ? '+' : ''}{r.points}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-400">{r.label}</div>
                <div className="text-xs text-slate-500 mt-0.5">{r.detail}</div>
                {r.key === 'fundamentals' && breakdown.fundamentals.factors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {breakdown.fundamentals.factors.map((f) => (
                      <div key={f.name} className="flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="text-slate-500">{f.name}</span>
                        <span className="text-slate-500">{f.value}</span>
                        <span className={ptsClass(f.points)}>{f.points > 0 ? '+' : ''}{f.points}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {breakdown.bearishVotes && (
            <div className="text-xs bg-rose-50 border border-rose-200 rounded-xl p-3 text-rose-200">
              <strong className="text-rose-600">SELL confirmation gate:</strong> {breakdown.bearishVotes.count} of 2+ bearish votes
              {breakdown.bearishVotes.count >= 2 ? ' — confirmed' : ' — not enough, downgraded to HOLD (avoids value traps)'}.
              {breakdown.bearishVotes.reasons.length > 0 && <div className="mt-1 text-rose-600/80">{breakdown.bearishVotes.reasons.join(' · ')}</div>}
            </div>
          )}
          <div className="text-[11px] text-slate-500">
            Deterministic scoring — same math the backtester runs. Trend ±25 · RSI ±15 · sentiment ±25 · fundamentals ±35. The total score is the components' sum, rounded.
            {action === 'SELL' ? '' : ' The AI narrative can only nudge the action when the score sits within 15 points of a boundary.'}
          </div>
        </div>
      )}
    </div>
  );
}

export function VerdictView({ symbol }: { symbol: string }) {
  const [v, setV] = useState<AiVerdict | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [earnings, setEarnings] = useState<{ earningsDate: string | null; daysUntil: number | null } | null>(null);

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

  // Next earnings date (earnings-calendar awareness). The verdict response now
  // carries `earnings` (svc-verdict fetches it in-mesh); this fetch is only a
  // fallback for cached/older responses.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/earnings?symbol=${encodeURIComponent(symbol)}`);
        if (res.ok && !cancelled) setEarnings(await res.json());
        else if (!cancelled) setEarnings(null);
      } catch { /* earnings banner is optional */ }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  // Pin this analysis ("I bought this and I'm holding") — snapshots the
  // verdict so it survives list churn and verdict changes; the alert checker
  // then protects the position (thesis-break alerts).
  const togglePin = async () => {
    if (!v || pinBusy) return;
    setPinBusy(true);
    try {
      if (pinned) {
        await fetch(`/api/pins?symbol=${encodeURIComponent(v.symbol)}`, { method: 'DELETE' });
        setPinned(false);
      } else {
        const res = await fetch('/api/pins', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            symbol: v.symbol,
            analysis: {
              action: v.verdict.action,
              confidence: v.verdict.confidence,
              score: v.breakdown?.score ?? null,
              price: v.price,
              buyZone: null,
              stopLoss: v.levels?.stopLoss ?? null,
              target1: v.levels?.target1 ?? null,
              horizon: v.verdict.horizon,
              validUntil: v.tradeWindow?.validUntil ?? null,
            },
          }),
        });
        if (res.ok) setPinned(true);
      }
    } catch { /* pin state is optimistic UI; alert checker tolerates gaps */ } finally {
      setPinBusy(false);
    }
  };

  // Is this symbol already on the watchlist?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/watchlist');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setWatched((data.symbols || []).some((s: { symbol: string }) => s.symbol === symbol.toUpperCase()));
        }
      } catch { /* watchlist unavailable — star stays off */ }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  // Is this symbol's analysis pinned (holding)?
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/pins');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setPinned((data.pins || []).some((p: { symbol: string }) => p.symbol === symbol.toUpperCase()));
        }
      } catch { /* pins unavailable — pin stays off */ }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  const toggleWatch = async () => {
    setWatchBusy(true);
    try {
      const res = watched
        ? await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: 'DELETE' })
        : await fetch('/api/watchlist', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ symbol }),
          });
      if (res.ok) setWatched(!watched);
    } finally {
      setWatchBusy(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-10 text-center">
        <BrainCircuit className="h-10 w-10 mx-auto text-cyan-600 animate-pulse mb-4" />
        <div className="text-slate-900 font-semibold">AI is researching {symbol}…</div>
        <div className="text-xs text-slate-500 mt-1">Reading SEC filings, charts and news, then forming a verdict</div>
      </div>
    );
  }

  if (error || !v) {
    return (
      <div className="glass-panel rounded-2xl p-10 text-center">
        <AlertTriangle className="h-8 w-8 mx-auto text-amber-600 mb-3" />
        <div className="text-slate-900">{error ?? 'No verdict available'}</div>
        <button onClick={load} className="mt-4 px-4 py-2 rounded-lg bg-cyan-50 text-cyan-700 text-sm hover:bg-cyan-50">
          Try again
        </button>
      </div>
    );
  }

  const style = ACTION_STYLES[v.verdict.action] ?? ACTION_STYLES.NEUTRAL;
  const earningsInfo = v.earnings ?? earnings;
  const ed = earningsInfo && earningsInfo.daysUntil != null && earningsInfo.daysUntil <= 21 && earningsInfo.daysUntil >= -1 ? earningsInfo : null;

  return (
    <div className="space-y-5">
      {/* Earnings-proximity banner */}
      {ed && (
        <div className="flex items-start gap-2 text-xs text-amber-200 bg-amber-50 border border-amber-200 rounded-xl p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
          <span>
            <strong className="text-amber-600">Earnings {ed.daysUntil! <= 0 ? 'is today/imminent' : `in ${ed.daysUntil} day${ed.daysUntil === 1 ? '' : 's'}`}</strong>
            {ed.earningsDate && <> ({new Date(ed.earningsDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})</>}
            {' — '}verdicts can shift sharply around earnings reports. Treat this rating with extra caution until the numbers are out.
          </span>
        </div>
      )}
      {/* Header + verdict badge */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center gap-6">
          <div className="flex-1">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <button
                onClick={togglePin}
                disabled={pinBusy}
                title={pinned ? `Unpin the ${v.symbol} analysis` : `Pin this analysis — you're holding ${v.symbol} and want thesis-break alerts`}
                className={`shrink-0 transition ${pinned ? 'text-indigo-600' : 'text-slate-400 hover:text-indigo-600'} disabled:opacity-50`}
              >
                <Pin className={`h-5 w-5 ${pinned ? 'fill-indigo-400' : ''}`} />
              </button>
              <button
                onClick={toggleWatch}
                disabled={watchBusy}
                title={watched ? `Remove ${v.symbol} from watchlist` : `Track ${v.symbol} — get alerted when the verdict changes`}
                className={`shrink-0 transition ${watched ? 'text-amber-600' : 'text-slate-400 hover:text-amber-600'} disabled:opacity-50`}
              >
                <Star className={`h-5 w-5 ${watched ? 'fill-amber-400' : ''}`} />
              </button>
              <span className="font-bold text-cyan-700 text-sm">{v.symbol}</span>
              <span>·</span>
              <span>{v.name}</span>
              {watched && <span className="text-[10px] text-amber-600/80">tracked · alerts on</span>}
              {pinned && <span className="text-[10px] text-indigo-600/90">📌 holding · thesis-break alerts on</span>}
            </div>
            <div className="flex items-baseline gap-3 mt-1">
              <span className="text-4xl font-bold text-slate-900">${v.price.toFixed(2)}</span>
              <span className="text-sm text-slate-500">
                · {v.technicals.trend === 'up' ? 'trending up' : v.technicals.trend === 'down' ? 'trending down' : 'moving sideways'}
                <MetricHelp term="rsi14" />
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-400 max-w-xl leading-relaxed">{v.verdict.summary}</p>
          </div>

          {/* Verdict badge + confidence */}
          <div className={`rounded-2xl border ${style.bg} p-5 min-w-[220px] text-center`}>
            <div className={`flex items-center justify-center gap-2 ${style.text}`}>{style.icon}</div>
            <div className={`text-3xl font-bold mt-1 ${style.text}`}>{style.label}</div>
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">AI confidence</div>
              <div className="text-xl font-bold text-slate-900">{Math.round(v.verdict.confidence)}%</div>
              <div className="h-1.5 rounded-full bg-slate-50 mt-1.5 overflow-hidden">
                <div className="h-full bg-cyan-400 rounded-full" style={{ width: `${v.verdict.confidence}%` }} />
              </div>
            </div>
            <div className="mt-2 text-[11px] text-slate-500 capitalize">Horizon: {v.verdict.horizon}-term</div>
            {v.tradeWindow && (
              <div className="mt-1.5 text-[11px] text-slate-500" title={`This analysis is meant to be acted on within ${v.tradeWindow.holdingDays} trading days. After that, re-analyze before acting on it.`}>
                <CalendarClock className="h-3 w-3 inline mr-1 text-slate-500" />
                Valid until <span className="text-slate-400 font-semibold">{new Date(v.tradeWindow.validUntil + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                <span className="text-slate-400"> · {v.tradeWindow.note}</span>
              </div>
            )}
            {v.ensemble && v.ensemble.consensus && (
              <div
                className="mt-3 pt-3 border-t border-slate-300"
                title={v.ensemble.votes.map((vt) => `${vt.model.split('/')[0]}: ${vt.verdict ?? 'error'}`).join(' · ')}
              >
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Model ensemble</div>
                <div className={`text-xs font-semibold ${v.ensemble.agreeing === v.ensemble.of ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {v.ensemble.agreeing}/{v.ensemble.of} models say {v.ensemble.consensus}
                </div>
                <div className="flex justify-center gap-1 mt-1.5">
                  {v.ensemble.votes.map((vt, i) => {
                    const c = vt.verdict === 'BUY' ? 'bg-emerald-400' : vt.verdict === 'SELL' ? 'bg-rose-400' : vt.verdict ? 'bg-amber-400' : 'bg-slate-200';
                    return <span key={i} className={`h-1.5 w-5 rounded-full ${c}`} title={`${vt.model}: ${vt.verdict ?? vt.error ?? '?'}`} />;
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <LevelLadder v={v} />
      </div>

      {/* Levels grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <LevelCard label="Target" help="price" value={v.levels.target1} color="text-emerald-600" sub="where the AI thinks it can go" />
        <LevelCard label="Stop Loss" help="price" value={v.levels.stopLoss} color="text-rose-600" sub="exit point to cap the loss" />
        <LevelCard label="Support" help="price" value={v.levels.supports[0]} color="text-rose-600" sub="price tends to bounce here" />
        <LevelCard label="Resistance" help="price" value={v.levels.resistances[0]} color="text-amber-600" sub="price tends to stall here" />
      </div>

      {/* Score drill-down — the receipts behind the verdict */}
      {v.breakdown && <ScoreBreakdown breakdown={v.breakdown} action={v.verdict.action} />}

      {/* Strategy */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="font-bold text-slate-900 flex items-center gap-2">
          <Target className="h-4 w-4 text-cyan-600" /> Suggested strategy
        </h3>
        <p className="text-sm text-slate-400 mt-2">{v.strategy.headline}</p>
        {v.strategy.entry && (
          <div className="mt-3 text-sm"><span className="text-slate-500">Entry zone:</span> <span className="text-slate-900">{v.strategy.entry}</span></div>
        )}
        <ul className="mt-3 space-y-2">
          {v.strategy.plan.map((p, i) => (
            <li key={i} className="flex gap-2 text-sm text-slate-400">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" /> {p}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 shrink-0" /> <span>{v.strategy.riskNote}</span>
        </div>
      </div>

      {/* Drivers: fundamentals / technicals / news */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-slate-900 flex items-center gap-2 mb-3">
            <ChevronUp className="h-4 w-4 text-emerald-600" /> What's working
          </h3>
          <ul className="space-y-2">
            {(v.drivers.bullish.length ? v.drivers.bullish : ['No strong positives detected from current data.']).map((b, i) => (
              <li key={i} className="text-sm text-slate-400 flex gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />{b}</li>
            ))}
          </ul>
          {v.fundamentals && (
            <div className="mt-4 pt-4 border-t border-slate-200 grid grid-cols-2 gap-3 text-xs">
              <FundStat label="Sales growth" help="revenueGrowthYoY" value={pct(v.fundamentals.revenueGrowthYoY)} />
              <FundStat label="Profit margin" help="netMargin" value={v.fundamentals.netMargin != null ? `${v.fundamentals.netMargin.toFixed(1)}%` : '—'} />
              <FundStat label="Efficiency (ROE)" help="roe" value={v.fundamentals.roe != null ? `${v.fundamentals.roe.toFixed(1)}%` : '—'} />
              <FundStat label="P/E" help="peRatio" value={v.fundamentals.peRatio?.toFixed(1) ?? '—'} />
              <div className="col-span-2 text-[10px] text-slate-500">
                Source: {v.fundamentals.source} ·{' '}
                <a
                  href={`https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(v.symbol)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-600 hover:text-cyan-700 underline"
                >
                  open the filings on SEC EDGAR ↗
                </a>
              </div>
            </div>
          )}
          <Receipts sentiment="bullish" news={v.drivers.newsItems} technicals={v.technicals} levels={v.levels} />
        </div>

        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-slate-900 flex items-center gap-2 mb-3">
            <ChevronDown className="h-4 w-4 text-rose-600" /> What's worrying
          </h3>
          <ul className="space-y-2">
            {(v.drivers.bearish.length ? v.drivers.bearish : ['No strong negatives detected from current data.']).map((b, i) => (
              <li key={i} className="text-sm text-slate-400 flex gap-2"><AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />{b}</li>
            ))}
          </ul>
          <Receipts sentiment="bearish" news={v.drivers.newsItems} technicals={v.technicals} levels={v.levels} />
        </div>
      </div>

      {/* News */}
      {v.drivers.newsItems?.length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-slate-900 flex items-center gap-2 mb-3">
            <Newspaper className="h-4 w-4 text-cyan-600" /> News the AI weighed
            <MetricHelp term="sentimentScore" />
          </h3>
          <div className="space-y-2">
            {v.drivers.newsItems.map((n, i) => (
              <div key={i} className="flex items-start gap-3 text-sm py-1.5 border-b border-slate-200 last:border-0">
                <span
                  className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                    n.sentiment === 'bullish'
                      ? 'bg-emerald-50 text-emerald-600'
                      : n.sentiment === 'bearish'
                        ? 'bg-rose-50 text-rose-600'
                        : 'bg-slate-50 text-slate-500'
                  }`}
                >
                  {n.sentiment}
                </span>
                <div className="min-w-0">
                  {n.url ? (
                    <a href={n.url} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-cyan-700 line-clamp-2">
                      {n.title}
                    </a>
                  ) : (
                    <span className="text-slate-400 line-clamp-2">{n.title}</span>
                  )}
                  <span className="text-[10px] text-slate-500 ml-2">{n.source}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Score evolution (accumulated by the userdata checker over time) */}
      <ScoreEvolution symbol={v.symbol} currentAction={v.verdict.action} currentConfidence={v.verdict.confidence} />

      {/* AI narrative (only when an LLM key is configured) */}
      {v.aiNarrative && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-slate-900 flex items-center gap-2 mb-3">
            <BrainCircuit className="h-4 w-4 text-cyan-600" /> AI deep analysis
          </h3>
          <div className="text-sm text-slate-400 leading-relaxed space-y-2">
            {v.aiNarrative.split('\n').map((line, i) => {
              const t = line.trim();
              if (!t) return <div key={i} className="h-1" />;
              // Headings (##, #)
              if (/^#{1,3}\s/.test(t))
                return (
                  <h4 key={i} className="font-bold text-slate-900 pt-2 pb-1">
                    {t.replace(/^#{1,3}\s*/, '')}
                  </h4>
                );
              // Bold via **...**
              const parts = t.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
              return (
                <p key={i}>
                  {parts.map((part, j) =>
                    part.startsWith('**') && part.endsWith('**') ? (
                      <strong key={j} className="text-slate-900 font-semibold">{part.slice(2, -2)}</strong>
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

/** Score evolution — how the AI's rating for this ticker has moved over time.
 *  Data accumulates from the watchlist checker (userdata verdict_history table). */
function ScoreEvolution({ symbol, currentAction, currentConfidence }: { symbol: string; currentAction: string; currentConfidence: number }) {
  const [history, setHistory] = useState<{ action: string; confidence: number | null; checkedAt: number }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/watchlist/history/${encodeURIComponent(symbol)}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setHistory(data.history || []);
        } else if (!cancelled) setHistory([]);
      } catch { if (!cancelled) setHistory([]); }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  if (!history || history.length < 3) return null; // not enough data yet — honest blank
  const pts = [...history, { action: currentAction, confidence: currentConfidence, checkedAt: Date.now() }];
  const W = 560, H = 90, PAD = 6;
  const min = 0, max = 100;
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
  const y = (c: number) => H - PAD - (c / (max - min)) * (H - 2 * PAD);
  const confPts = pts.filter((p) => p.confidence != null);
  const line = confPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(confPts.length === pts.length ? pts.indexOf(p) : i)},${y(p.confidence!)}`).join(' ');
  const actionColor = (a: string) => (a === 'BUY' ? '#059669' : a === 'SELL' ? '#e11d48' : '#d97706');
  const first = pts[0], last = pts[pts.length - 1];
  const changed = pts.filter((p, i) => i > 0 && p.action !== pts[i - 1].action).length;

  return (
    <div className="glass-panel rounded-2xl p-6">
      <h3 className="font-bold text-slate-900 flex items-center gap-2 mb-1">
        <TrendingUp className="h-4 w-4 text-cyan-600" /> Score evolution
      </h3>
      <p className="text-xs text-slate-500 mb-3">
        How the AI has rated {symbol} over its last {pts.length} checks · {changed} rating change{changed === 1 ? '' : 's'} recorded
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[90px]">
        <line x1={PAD} y1={y(35)} x2={W - PAD} y2={y(35)} stroke="#05966966" strokeDasharray="4 4" strokeWidth="1" />
        <text x={W - PAD} y={y(35) - 3} textAnchor="end" fontSize="8" fill="#059669">BUY threshold (35)</text>
        <path d={line} fill="none" stroke="#0284c7" strokeWidth="1.5" />
        {confPts.map((p, i) => (
          <circle
            key={i}
            cx={x(confPts.length === pts.length ? pts.indexOf(p) : i)}
            cy={y(p.confidence!)}
            r="3"
            fill={actionColor(p.action)}
          >
            <title>{new Date(p.checkedAt).toLocaleString()} · {p.action} · {p.confidence}%</title>
          </circle>
        ))}
      </svg>
      <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1">
        <span>{new Date(first.checkedAt).toLocaleDateString()}: {first.action}</span>
        <span>Now: <strong style={{ color: actionColor(last.action) }}>{last.action} {last.confidence}%</strong></span>
      </div>
    </div>
  );
}

/** "Show the receipts" — expandable evidence behind each driver panel. */
function Receipts({ sentiment, news, technicals, levels }: {
  sentiment: 'bullish' | 'bearish';
  news: { title: string; source: string; url?: string; sentiment: string; score: number }[];
  technicals: { trend: string; rsi14?: number; sentimentScore?: number };
  levels: AiVerdict['levels'];
}) {
  const [open, setOpen] = useState(false);
  const relevant = news.filter((n) => n.sentiment === sentiment).sort((a, b) =>
    sentiment === 'bullish' ? b.score - a.score : a.score - b.score
  );

  return (
    <div className="mt-4 pt-4 border-t border-slate-200">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-cyan-600 hover:text-cyan-700 flex items-center gap-1.5"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        {open ? 'Hide the receipts' : `Show the receipts (${relevant.length} headline${relevant.length === 1 ? '' : 's'} + indicator math)`}
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-xs">
          {/* News evidence */}
          {relevant.length > 0 && (
            <div>
              <div className="text-slate-500 uppercase tracking-wider text-[10px] mb-1.5">
                {sentiment === 'bullish' ? 'Positive headlines, strongest first' : 'Negative headlines, most concerning first'}
              </div>
              <div className="space-y-1.5">
                {relevant.map((n, i) => (
                  <div key={i} className="flex items-baseline gap-2">
                    <span className={`shrink-0 font-mono ${sentiment === 'bullish' ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {n.score > 0 ? '+' : ''}{n.score.toFixed(1)}
                    </span>
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-cyan-700 line-clamp-1">
                        {n.title}
                      </a>
                    ) : (
                      <span className="text-slate-400 line-clamp-1">{n.title}</span>
                    )}
                    <span className="shrink-0 text-slate-400">{n.source}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Indicator math */}
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px] mb-1.5">Indicator math behind this panel</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-400">
              <span className="text-slate-500">Trend</span>
              <span>
                {technicals.trend === 'up'
                  ? 'price above SMA50 and SMA50 above SMA200'
                  : technicals.trend === 'down'
                    ? 'price below SMA50 and SMA50 below SMA200'
                    : 'price between its key averages (no clean trend)'}
              </span>
              <span className="text-slate-500">RSI(14)</span>
              <span>{technicals.rsi14 != null ? technicals.rsi14.toFixed(1) : '—'} — {technicals.rsi14 == null ? 'no data' : technicals.rsi14 > 70 ? 'overbought zone (>70)' : technicals.rsi14 > 55 ? 'elevated (55–70)' : technicals.rsi14 < 30 ? 'oversold zone (<30)' : technicals.rsi14 < 45 ? 'soft (30–45)' : 'neutral (45–55)'}</span>
              {levels.sma50 != null && (<><span className="text-slate-500">SMA 50</span><span>${levels.sma50.toFixed(2)}</span></>)}
              {levels.sma200 != null && (<><span className="text-slate-500">SMA 200</span><span>${levels.sma200.toFixed(2)}</span></>)}
              {levels.sma20 != null && (<><span className="text-slate-500">SMA 20</span><span>${levels.sma20.toFixed(2)}</span></>)}
              {levels.atr14 != null && (<><span className="text-slate-500">ATR(14)</span><span>${levels.atr14.toFixed(2)} — typical daily range</span></>)}
            </div>
            <div className="mt-2 text-[10px] text-slate-400">
              Scoring: trend contributes ±25, RSI position ±15, news sentiment ±25, fundamentals ±35 → final score −100..100.
              BUY needs ≥35; SELL needs a low score <em>plus</em> two independent bearish confirmations.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LevelCard({ label, value, color, sub, help }: { label: string; value?: number; color: string; sub: string; help: string }) {
  return (
    <div className="glass-panel rounded-xl p-4">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1">
        {label} <MetricHelp term={help} />
      </div>
      <div className={`text-2xl font-bold mt-1 ${value != null ? color : 'text-slate-400'}`}>
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
      <div className="text-slate-400 font-semibold">{value}</div>
    </div>
  );
}
