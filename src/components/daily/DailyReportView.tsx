'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Trophy, RefreshCw, Loader2, CalendarClock, ArrowUpRight, AlertTriangle, CheckCircle2 } from 'lucide-react';

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
  error?: string;
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
  results?: DailyRow[];
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
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/daily-report');
      if (res.ok) setReport(await res.json());
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
          <div className="text-[11px] text-slate-600 flex items-center gap-1.5 px-1 pt-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500/60" />
            Click any row for the full verdict — the research is already done, so it loads instantly.
          </div>
        </div>
      )}
    </div>
  );
}
