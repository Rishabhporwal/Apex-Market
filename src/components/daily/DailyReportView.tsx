'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Trophy, RefreshCw, Loader2, CalendarClock, ArrowUpRight, AlertTriangle, CheckCircle2, Coins, Pin, X, Sparkles } from 'lucide-react';

interface DailyRow {
  symbol: string;
  name: string;
  tier?: 'core' | 'fresh';
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
  tradePlan?: { entry: number | null; entryHigh?: number; stop: number | null; target1: number | null; target2?: number | null; etaTarget1Days?: number | null; etaTarget2Days?: number | null; etaReliable?: boolean | null; riskPerShare: number | null; riskPct?: number; rewardRisk: number | null; requiredRR?: number | null; geometryNote?: string | null; lowRR: boolean } | null;
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
  BUY: 'bg-white text-emerald-600 border-emerald-200',
  SELL: 'bg-white text-rose-600 border-rose-200',
  HOLD: 'bg-white text-amber-600 border-amber-200',
  NEUTRAL: 'bg-white text-slate-500 border-slate-200',
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
      // send a minimal JSON body — an empty body with content-type json makes
      // Fastify downstream reject with FST_ERR_CTP_EMPTY_JSON_BODY
      const res = await fetch('/api/daily-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (res.ok) setReport(await res.json());
      else {
        const body = await res.json().catch(() => ({}));
        const friendly: Record<number, string> = {
          409: 'A run is already in progress — it usually takes a few minutes. The results will appear here when it finishes.',
          502: "Couldn't reach the research services. Check that the platform (gateway) is running, then try again.",
          504: 'The run took too long to acknowledge, but it may still be finishing server-side — check back in a few minutes.',
        };
        setRunError(friendly[res.status] || body.error || `Run failed (${res.status})`);
      }
    } catch {
      setRunError('Could not reach the research service');
    } finally {
      setRunning(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-2xl bg-[#fafafa] border border-slate-200 p-10 text-center">
        <Loader2 className="h-8 w-8 mx-auto animate-spin text-slate-400 mb-3" />
        <div className="text-slate-500 text-sm">Loading today's research…</div>
      </div>
    );
  }

  const rows = (report?.results || []).filter((r) => !r.error);
  const failed = (report?.results || []).filter((r) => r.error);

  return (
    <div className="rounded-2xl bg-[#fafafa] border border-slate-200 p-5 sm:p-8 text-slate-900 space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start gap-4 justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 flex items-center gap-2">
            <Trophy className="h-5 w-5 text-slate-400" /> Today's Top 5
          </h2>
          <p className="text-sm text-slate-500 mt-1.5 max-w-2xl leading-relaxed">
            The 5 highest-quality companies under $400/share (SEC-filed fundamentals) analyzed once daily, one hour
            before market open — ranked best-first. Sizing is generic; apply your own risk budget. Same research is reused all day; prices and levels stay live.
          </p>
          {report?.available && (
            <div className="mt-2.5 flex items-center gap-3 text-[11px] text-slate-400 flex-wrap tabular-nums">
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
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 active:bg-slate-800 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          title="Run the full Top-15 research now (takes a few minutes)"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {running ? 'Running full research…' : 'Run now'}
        </button>
      </div>
      {runError && (
        <div className="flex gap-2 items-start text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-px" /> {runError}
        </div>
      )}

      {/* Pinned holdings — analyses you pinned while holding; they persist even
          when the symbol drops off the daily list or the verdict changes. The
          alert checker raises thesis-break alerts on these. */}
      {pins.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2 mb-3">
            <Pin className="h-4 w-4 text-slate-400" /> Held positions
            <span className="text-[11px] font-normal text-slate-400">— pinned analyses, protected by thesis-break alerts</span>
          </h3>
          <div className="space-y-2">
            {pins.map((p) => {
              const a = p.analysis || {};
              const expired = a.validUntil ? new Date(a.validUntil + 'T23:59:59') < new Date() : false;
              const inList = (report?.results || []).some((r) => r.symbol === p.symbol);
              return (
                <div key={p.symbol} className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-3.5 hover:border-slate-300 transition">
                  <Pin className="h-4 w-4 text-slate-300 shrink-0" />
                  <button onClick={() => onSelectSymbol(p.symbol)} className="text-left min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900 text-sm">{p.symbol}</span>
                      {a.action && <span className={'px-2 py-0.5 rounded-full border text-[10px] font-semibold ' + (ACTION_STYLES[a.action] || ACTION_STYLES.NEUTRAL)}>{a.action}</span>}
                      <span className="text-[11px] text-slate-400 tabular-nums">pinned {new Date(p.pinnedAt).toLocaleDateString()} @ ${a.price?.toFixed(2) ?? '—'}</span>
                      {a.validUntil && (
                        <span className={'text-[10px] px-1.5 py-0.5 rounded-full border ' + (expired ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-white text-slate-400 border-slate-200')}>
                          {expired ? 'window expired — re-analyze' : 'valid until ' + new Date(a.validUntil + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                      {!inList && <span className="text-[10px] text-slate-400">not in today's list — still tracked</span>}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
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
                    className="text-slate-300 hover:text-rose-500 transition shrink-0"
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
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-500">
          <Trophy className="h-8 w-8 mx-auto mb-3 text-slate-300" />
          No daily report yet. Hit "Run now" to generate the first one — then it refreshes automatically every weekday at 8:30 AM ET.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r, i) => (
            <button
              key={r.symbol}
              onClick={() => r.action && onSelectSymbol(r.symbol)}
              className="w-full text-left bg-white border border-slate-200 rounded-xl p-4 sm:p-5 hover:border-slate-300 hover:shadow-sm transition group"
            >
              <div className="flex items-start gap-4">
                <div className={`shrink-0 w-8 pt-px text-center text-xl font-bold tabular-nums leading-none ${i === 0 ? 'text-slate-900' : 'text-slate-300'}`}>
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-900">{r.symbol}</span>
                    <span className="text-xs text-slate-400 truncate max-w-[220px]">{r.name}</span>
                    {r.action && <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${ACTION_STYLES[r.action] || ACTION_STYLES.NEUTRAL}`}>{r.action}</span>}
                    {r.confidence != null && <span className="text-[11px] text-slate-400 tabular-nums">{r.confidence}% confidence</span>}
                    {r.tier === 'fresh' && (
                      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-cyan-50 text-cyan-600 border border-cyan-100" title="New candidate — analyzed today for the first time in 7+ days">
                        <Sparkles className="h-3 w-3" /> new today
                      </span>
                    )}
                    {r.score != null && <span className="text-[11px] text-slate-300 tabular-nums">score {r.score}</span>}
                    {r.earnings?.daysUntil != null && r.earnings.daysUntil >= -1 && r.earnings.daysUntil <= 21 && (
                      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-200">
                        <CalendarClock className="h-3 w-3" /> ER {r.earnings.daysUntil <= 0 ? 'now' : `${r.earnings.daysUntil}d`}
                      </span>
                    )}
                    {r.cachedAnalysis && (
                      <span className="text-[10px] text-slate-300" title="Narrative reused from today's run — prices and levels are live">cached analysis</span>
                    )}
                    {r.llm && (
                      <span
                        className="text-[10px] text-slate-300 font-mono tabular-nums"
                        title={(r.llm.models || []).map((m) => `${m.model}: ${m.promptTokens + m.completionTokens} tokens ($${m.costUsd.toFixed(4)})`).join('\n') || 'no LLM spend — cached narrative'}
                      >
                        {r.llm.promptTokens + r.llm.completionTokens > 0
                          ? `${((r.llm.promptTokens + r.llm.completionTokens) / 1000).toFixed(1)}k tok · $${r.llm.costUsd.toFixed(4)}`
                          : '0 tok · $0.00 (cached)'}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-6 gap-x-6 gap-y-2 text-xs tabular-nums">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">Buy zone</div>
                      <div className="text-slate-900 font-medium">{r.buyZone || '—'}</div>
                    </div>
                    <div className="col-span-2 sm:col-span-2">
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">Targets · ETA</div>
                      <div className="text-slate-900 font-medium">
                        {fmt(r.target1)} <span className="text-slate-300">/</span> {fmt(r.target2)}
                        {r.tradePlan && (r.tradePlan.etaTarget1Days != null ? <span className="text-slate-400 font-normal"> · ~{r.tradePlan.etaTarget1Days}d{r.tradePlan.etaTarget2Days != null && <> / ~{r.tradePlan.etaTarget2Days}d</>}</span> : <span className="text-slate-400 font-normal"> · ETA n/a — trend too weak</span>)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">Stop</div>
                      <div className="text-rose-600 font-medium">{fmt(r.stopLoss)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">Risk</div>
                      {r.tradePlan ? (
                        <div className="text-slate-900 font-medium">
                          <span className={r.tradePlan.rewardRisk != null && r.tradePlan.rewardRisk >= (r.tradePlan.requiredRR ?? 1.5) ? 'text-emerald-600' : 'text-amber-600'}>{r.tradePlan.rewardRisk != null ? `${r.tradePlan.rewardRisk.toFixed(2)}:1` : '—'}</span>
                          {' · '}${r.tradePlan.riskPerShare?.toFixed(2) ?? '—'}{r.tradePlan.riskPct != null ? ` (${r.tradePlan.riskPct.toFixed(1)}%)` : ''}
                          {r.tradePlan.requiredRR != null && Math.abs(r.tradePlan.requiredRR - 1.5) > 1e-9 && <span className="text-slate-400 font-normal" title={`Adaptive required reward-to-risk from calibrated confidence (standard bar is 1.5x)`}> · R&gt;={r.tradePlan.requiredRR.toFixed(2).replace(/\.?0+$/, '')} (adaptive)</span>}
                          {r.tradePlan.lowRR && <span className="text-amber-600 font-normal" title="Reward-to-risk below the required bar for this plan"> · ⚠ thin R:R</span>}
                        </div>
                      ) : (
                        <div className="text-slate-300">—</div>
                      )}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">Price</div>
                      <div className="text-slate-900 font-medium">{fmt(r.price)}</div>
                    </div>
                  </div>
                  {r.tradePlan?.geometryNote && <p className="mt-2 text-[11px] text-slate-400 font-mono tabular-nums">{r.tradePlan.geometryNote}</p>}
                  {r.reason && <p className="mt-3 text-xs text-slate-400 leading-relaxed line-clamp-2">{r.reason}</p>}
                </div>
                <ArrowUpRight className="h-4 w-4 text-slate-300 group-hover:text-slate-500 transition shrink-0 mt-1" />
              </div>
            </button>
          ))}
          {failed.length > 0 && (
            <div className="text-[11px] text-slate-400 flex items-center gap-2 px-1">
              <AlertTriangle className="h-3.5 w-3.5" /> {failed.length} symbol(s) failed this run: {failed.map((f) => f.symbol).join(', ')}
            </div>
          )}
          {report.llmUsage && (
            <div className="text-[11px] text-slate-400 flex items-center gap-2 px-1 pt-3 border-t border-slate-200">
              <Coins className="h-3.5 w-3.5 text-slate-300" />
              <span className="font-mono tabular-nums">
                Run cost: ${report.llmUsage.costUsd.toFixed(4)}
                {' '}· {((report.llmUsage.promptTokens + report.llmUsage.completionTokens) / 1000).toFixed(1)}k tokens
                ({(report.llmUsage.promptTokens / 1000).toFixed(1)}k in / {(report.llmUsage.completionTokens / 1000).toFixed(1)}k out)
                · ~${(report.llmUsage.costUsd * 21).toFixed(2)}/mo at ~21 trading days
              </span>
            </div>
          )}
          <div className="text-[11px] text-slate-400 flex items-center gap-1.5 px-1 pt-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            Click any row for the full verdict — the research is already done, so it loads instantly.
          </div>
        </div>
      )}
    </div>
  );
}
