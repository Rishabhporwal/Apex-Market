'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Trophy, RefreshCw, Loader2, CalendarClock, ArrowUpRight, AlertTriangle, CheckCircle2, Coins, Pin, X, Sparkles } from 'lucide-react';

interface DailyRow {
  symbol: string;
  name: string;
  action?: string;
  confidence?: number;
  score?: number;
  horizon?: string;
  price?: number;
  buyZone?: string | null;
  target1?: number;
  target2?: number;
  stopLoss?: number;
  reason?: string;
  earnings?: { earningsDate: string | null; daysUntil: number | null } | null;
  cachedAnalysis?: boolean;
  llm?: { promptTokens: number; completionTokens: number; costUsd: number; models: { model: string; promptTokens: number; completionTokens: number; costUsd: number }[] };
  error?: string;
}

interface PinnedAnalysis {
  symbol: string;
  pinnedAt: number;
  analysis: {
    action?: string; confidence?: number; score?: number; price?: number;
    stopLoss?: number; target1?: number; horizon?: string; validUntil?: string;
  } | null;
}

interface DailyReport {
  available: boolean;
  isToday?: boolean;
  date?: string;
  ranAt?: number;
  durationMs?: number;
  count?: number;
  universeWeek?: string;
  nextRunAt?: string;
  llmUsage?: { promptTokens: number; completionTokens: number; costUsd: number; models?: unknown[] };
  results?: DailyRow[];
  fresh?: DailyRow[];
}

const ACTION_STYLES: Record<string, string> = {
  BUY: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  SELL: 'bg-rose-500/15 text-rose-400 border-rose-500/40',
  HOLD: 'bg-amber-500/15 text-amber-400 border-amber-500/40',
  NEUTRAL: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
};

const fmt = (v?: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);

/** Today's Top-15: the daily pre-market research run, ranked best-first.
 *  Each row carries the full trade plan; click through for the complete verdict
 *  (it's a research-cache hit — instant and free). */
export function DailyReportView({ onSelectSymbol }: { onSelectSymbol: (sym: string) => void }) {
  const [report, setReport] = useState<DailyReport | null>(null);
  const [pins, setPins] = useState<PinnedAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, pinRes] = await Promise.all([fetch('/api/daily-report'), fetch('/api/pins')]);
      if (res.ok) setReport(await res.json());
      if (pinRes.ok) setPins((await pinRes.json()).pins || []);
    } catch { /* offline */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runNow = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch('/api/daily-report', { method: 'POST' });
      if (res.ok) setReport(await res.json());
      else {
        const body = await res.json().catch(() => ({}));
        setRunError(body.error || `Run failed (${res.status})`);
      }
    } catch {
      setRunError('Could not reach the research service');
    } finally {
      setRunning(false);
    }
  };

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-10 text-center">
        <Loader2 className="h-8 w-8 mx-auto animate-spin text-cyan-400 mb-3" />
        <div className="text-slate-400 text-sm">Loading today's research…</div>
      </div>
    );
  }

  const rows = (report?.results || []).filter((r) => !r.error);
  const failed = (report?.results || []).filter((r) => r.error);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Trophy className="h-5 w-5 text-amber-400" /> Today's Top 5
            </h2>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              The 5 highest-quality companies under $400/share (SEC-filed fundamentals) analyzed once daily, one hour
              before market open — ranked best-first. Sized for a small account. Same research is reused all day; prices and levels stay live.
            </p>
            {report?.available && (
              <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500 flex-wrap">
                <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" /> {report.date}{!report.isToday && ' (latest available)'}</span>
                {report.universeWeek && <span>universe {report.universeWeek}</span>}
                {report.nextRunAt && <span>next run {new Date(report.nextRunAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                {report.durationMs && <span>ran in {Math.round(report.durationMs / 1000)}s</span>}
              </div>
            )}
          </div>
          <button
            onClick={runNow}
            disabled={running}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-sm font-semibold hover:bg-cyan-500/30 transition disabled:opacity-50 shrink-0"
            title="Run the full Top-15 research now (takes a few minutes)"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {running ? 'Running full research…' : 'Run now'}
          </button>
        </div>
        {runError && (
          <div className="mt-3 flex gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {runError}
          </div>
        )}
      </div>

      {/* Pinned holdings — analyses you pinned while holding; they persist even
          when the symbol drops off the daily list or the verdict changes. The
          alert checker raises thesis-break alerts on these. */}
      {pins.length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="font-bold text-white flex items-center gap-2 mb-1">
            <Pin className="h-4 w-4 text-indigo-400" /> Held positions
            <span className="text-[10px] font-normal text-slate-500">— pinned analyses, protected by thesis-break alerts</span>
          </h3>
          <div className="mt-3 space-y-2">
            {pins.map((p) => {
              const a = p.analysis || {};
              const expired = a.validUntil ? new Date(a.validUntil + 'T23:59:59') < new Date() : false;
              const inList = (report?.results || []).some((r) => r.symbol === p.symbol);
              return (
                <div key={p.symbol} className="flex items-center gap-3 bg-slate-900/40 border border-indigo-500/20 rounded-xl p-3">
                  <Pin className="h-4 w-4 text-indigo-400 shrink-0 fill-indigo-400/40" />
                  <button onClick={() => onSelectSymbol(p.symbol)} className="text-left min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-white text-sm">{p.symbol}</span>
                      {a.action && <span className={'px-2 py-0.5 rounded-full border text-[10px] font-bold ' + (ACTION_STYLES[a.action] || ACTION_STYLES.NEUTRAL)}>{a.action}</span>}
                      <span className="text-[11px] text-slate-500">pinned {new Date(p.pinnedAt).toLocaleDateString()} @ ${a.price?.toFixed(2) ?? '—'}</span>
                      {a.validUntil && (
                        <span className={'text-[10px] px-1.5 py-0.5 rounded-full ' + (expired ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-700/40 text-slate-400')}>
                          {expired ? 'window expired — re-analyze' : 'valid until ' + new Date(a.validUntil + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                      {!inList && <span className="text-[10px] text-slate-600">not in today's list — still tracked</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {a.stopLoss != null && <span>stop ${a.stopLoss.toFixed(2)} · </span>}
                      {a.target1 != null && <span>target ${a.target1.toFixed(2)} · </span>}
                      <span>thesis-break alerts active</span>
                    </div>
                  </button>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      await fetch('/api/pins?symbol=' + encodeURIComponent(p.symbol), { method: 'DELETE' });
                      setPins((prev) => prev.filter((x) => x.symbol !== p.symbol));
                    }}
                    className="text-slate-600 hover:text-rose-400 transition shrink-0"
                    title={'Unpin ' + p.symbol + ' (you no longer hold it)'}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Ranked rows */}
      {!report?.available ? (
        <div className="glass-panel rounded-2xl p-10 text-center text-slate-500">
          <Trophy className="h-8 w-8 mx-auto mb-3 text-slate-700" />
          No daily report yet. Hit "Run now" to generate the first one — then it refreshes automatically every weekday at 8:30 AM ET.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <button
              key={r.symbol}
              onClick={() => r.action && onSelectSymbol(r.symbol)}
              className="w-full text-left glass-panel rounded-xl p-4 hover:border-cyan-500/40 transition group"
            >
              <div className="flex items-start gap-4">
                <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${i === 0 ? 'bg-amber-400/20 text-amber-300' : i < 3 ? 'bg-slate-400/15 text-slate-200' : 'bg-slate-800 text-slate-500'}`}>
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-white">{r.symbol}</span>
                    <span className="text-xs text-slate-500 truncate max-w-[200px]">{r.name}</span>
                    {r.action && <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${ACTION_STYLES[r.action] || ACTION_STYLES.NEUTRAL}`}>{r.action}</span>}
                    {r.confidence != null && <span className="text-[11px] text-slate-500">{r.confidence}% confidence</span>}
                    {r.score != null && <span className="text-[11px] text-slate-600">score {r.score}</span>}
                    {r.earnings?.daysUntil != null && r.earnings.daysUntil >= -1 && r.earnings.daysUntil <= 21 && (
                      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/15 text-amber-400">
                        <CalendarClock className="h-3 w-3" /> ER {r.earnings.daysUntil <= 0 ? 'now' : `${r.earnings.daysUntil}d`}
                      </span>
                    )}
                    {r.cachedAnalysis && (
                      <span className="text-[10px] text-slate-600" title="Narrative reused from today's run — prices and levels are live">cached analysis</span>
                    )}
                    {r.llm && (
                      <span
                        className="text-[10px] text-slate-600"
                        title={(r.llm.models || []).map((m) => `${m.model}: ${m.promptTokens + m.completionTokens} tokens ($${m.costUsd.toFixed(4)})`).join('\n') || 'no LLM spend — cached narrative'}
                      >
                        {r.llm.promptTokens + r.llm.completionTokens > 0
                          ? `${((r.llm.promptTokens + r.llm.completionTokens) / 1000).toFixed(1)}k tok · $${r.llm.costUsd.toFixed(4)}`
                          : '0 tok · $0.00 (cached)'}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[11px]">
                    <div><span className="text-slate-500">Buy zone:</span> <span className="text-emerald-300 font-semibold">{r.buyZone || '—'}</span></div>
                    <div><span className="text-slate-500">Targets:</span> <span className="text-emerald-400">{fmt(r.target1)}</span> <span className="text-slate-600">/</span> <span className="text-emerald-500">{fmt(r.target2)}</span></div>
                    <div><span className="text-slate-500">Stop:</span> <span className="text-rose-400 font-semibold">{fmt(r.stopLoss)}</span></div>
                    <div><span className="text-slate-500">Price:</span> <span className="text-white">{fmt(r.price)}</span></div>
                  </div>
                  {r.reason && <p className="mt-2 text-[11px] text-slate-500 line-clamp-2">{r.reason}</p>}
                </div>
                <ArrowUpRight className="h-4 w-4 text-slate-600 group-hover:text-cyan-400 transition shrink-0 mt-1" />
              </div>
            </button>
          ))}
          {failed.length > 0 && (
            <div className="text-[11px] text-slate-600 flex items-center gap-2 px-1">
              <AlertTriangle className="h-3.5 w-3.5" /> {failed.length} symbol(s) failed this run: {failed.map((f) => f.symbol).join(', ')}
            </div>
          )}
          {(report.fresh || []).length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-800/60">
              <h3 className="font-bold text-white flex items-center gap-2 mb-2 text-sm">
                <Sparkles className="h-4 w-4 text-cyan-400" /> Fresh candidates today
                <span className="text-[10px] font-normal text-slate-500">— new quality names analyzed for the first time in 7+ days</span>
              </h3>
              <div className="space-y-2">
                {(report.fresh || []).filter((r) => !r.error).map((r) => (
                  <button
                    key={r.symbol}
                    onClick={() => r.action && onSelectSymbol(r.symbol)}
                    className="w-full text-left glass-panel rounded-xl p-3 hover:border-cyan-500/40 transition group"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Sparkles className="h-3 w-3 text-cyan-400" />
                      <span className="font-bold text-white text-sm">{r.symbol}</span>
                      <span className="text-xs text-slate-500 truncate max-w-[180px]">{r.name}</span>
                      {r.action && <span className={'px-2 py-0.5 rounded-full border text-[10px] font-bold ' + (ACTION_STYLES[r.action] || ACTION_STYLES.NEUTRAL)}>{r.action}</span>}
                      {r.confidence != null && <span className="text-[11px] text-slate-500">{r.confidence}%</span>}
                      {r.price != null && <span className="text-[11px] text-slate-400">${r.price.toFixed(2)}</span>}
                      {r.llm && r.llm.promptTokens + r.llm.completionTokens > 0 && (
                        <span className="text-[10px] text-slate-600">{((r.llm.promptTokens + r.llm.completionTokens) / 1000).toFixed(1)}k tok · ${r.llm.costUsd.toFixed(4)}</span>
                      )}
                    </div>
                    {r.reason && <p className="mt-1 text-[11px] text-slate-500 line-clamp-2">{r.reason}</p>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {report.llmUsage && (
            <div className="text-[11px] text-slate-500 flex items-center gap-2 px-1 pt-2 border-t border-slate-800/60 mt-2 pt-3">
              <Coins className="h-3.5 w-3.5 text-amber-500/70" />
              <span>
                Run cost: <strong className="text-slate-300">${report.llmUsage.costUsd.toFixed(4)}</strong>
                {' '}· {((report.llmUsage.promptTokens + report.llmUsage.completionTokens) / 1000).toFixed(1)}k tokens
                ({(report.llmUsage.promptTokens / 1000).toFixed(1)}k in / {(report.llmUsage.completionTokens / 1000).toFixed(1)}k out)
                · ~${(report.llmUsage.costUsd * 21).toFixed(2)}/mo at ~21 trading days
              </span>
            </div>
          )}
          <div className="text-[11px] text-slate-600 flex items-center gap-1.5 px-1 pt-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/60" />
            Click any row for the full verdict — the research is already done, so it loads instantly.
          </div>
        </div>
      )}
    </div>
  );
}
