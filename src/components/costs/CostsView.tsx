'use client';

/**
 * CostsView — "💰 Costs" tab. Full view of LLM token/cost usage per day and
 * per stock, fed by svc-llm's usage ledger (data/llm-usage.db) via
 * /api/llm-usage. Light minimal design language (2026): white cards, 1px
 * slate-200 borders, tabular numerals, semantic text colors.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Wallet, Coins, PiggyBank, RefreshCw, CalendarDays, Building2, ListChecks, AlertCircle } from 'lucide-react';

interface UsageWindow {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  cachedHits: number;
  freshCalls: number;
  avgFreshCostUsd: number;
  estSavedUsd: number;
}

interface UsageRow {
  date: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cachedHits: number;
  freshCalls: number;
}

interface SymbolRow {
  symbol: string;
  analyses: number;
  tokens: number;
  costUsd: number;
  cachedHits: number;
  lastAnalyzed: number;
}

interface CallRow {
  ts: number;
  symbol: string | null;
  context: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cachedHit: number;
}

interface UsageResponse {
  ok: boolean;
  days: number;
  symbol: string | null;
  ledgerAvailable: boolean;
  totals: Record<string, UsageWindow>;
  daily: UsageRow[];
  bySymbol: SymbolRow[];
  recent: CallRow[];
}

const fmtUsd = (v: number) =>
  v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : '$0';
const fmtTokens = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : `${v}`;
const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function StatCard({ label, value, sub, icon: Icon, tone = 'slate' }: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'slate' | 'emerald';
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</span>
        <Icon className={`h-4 w-4 ${tone === 'emerald' ? 'text-emerald-600' : 'text-muted'}`} />
      </div>
      <div className="mt-1.5 text-2xl font-bold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted tabular-nums">{sub}</div>}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white py-10 text-center">
      <AlertCircle className="h-5 w-5 text-muted" />
      <p className="mt-2 text-sm text-muted">{message}</p>
      <p className="mt-1 text-xs text-muted">Usage is recorded from now on — run an AI analysis to populate this view.</p>
    </div>
  );
}

export function CostsView() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/llm-usage?days=30');
      if (!res.ok) {
        setError(res.status === 502 ? 'Cost service unreachable — check the gateway.' : `Could not load usage (status ${res.status}).`);
        setData(null);
      } else {
        setData(await res.json());
      }
    } catch {
      setError('Cost service unreachable — check the gateway.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const totals = data?.totals || {};
  const today = totals.today;
  const d7 = totals.d7;
  const d30 = totals.d30;
  const daily = data?.daily || [];
  const bySymbol = data?.bySymbol || [];
  const recent = data?.recent || [];
  const noDataAtAll = !!data && daily.length === 0 && bySymbol.length === 0 && recent.length === 0;
  const maxDailyCost = Math.max(...daily.map((d) => d.costUsd || 0), 0.000001);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">💰 Costs & Token Usage</h1>
          <p className="text-xs text-muted">Every LLM call is recorded to the usage ledger — per day, per stock, with cache savings.</p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition"
          disabled={loading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">{error}</div>
      )}

      {/* Header cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Today"
          value={fmtUsd(today?.costUsd ?? 0)}
          sub={`${today?.calls ?? 0} calls · ${fmtTokens(today?.totalTokens ?? 0)} tokens`}
          icon={Wallet}
        />
        <StatCard
          label="Last 7 days"
          value={fmtUsd(d7?.costUsd ?? 0)}
          sub={`${d7?.calls ?? 0} calls · ${fmtTokens(d7?.totalTokens ?? 0)} tokens`}
          icon={Coins}
        />
        <StatCard
          label="Last 30 days"
          value={fmtUsd(d30?.costUsd ?? 0)}
          sub={`${d30?.calls ?? 0} calls · ${fmtTokens(d30?.totalTokens ?? 0)} tokens`}
          icon={Coins}
        />
        <StatCard
          label="Saved by cache"
          value={fmtUsd(d30?.estSavedUsd ?? 0)}
          sub={`${d30?.cachedHits ?? 0} cache hits × ${fmtUsd(d30?.avgFreshCostUsd ?? 0)} avg fresh analysis`}
          icon={PiggyBank}
          tone="emerald"
        />
      </div>

      {noDataAtAll ? (
        <EmptyState message="No usage recorded yet." />
      ) : (
        <>
          {/* Per-day view */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-muted" />
              <h2 className="text-sm font-semibold text-slate-900">Usage per day</h2>
              <span className="text-xs text-muted">(last {data?.days ?? 30} days)</span>
            </div>
            {daily.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No usage in this window.</p>
            ) : (
              <div className="mt-4 space-y-1.5">
                {[...daily].reverse().map((d) => (
                  <div key={d.date} className="flex items-center gap-3 text-xs">
                    <span className="w-24 shrink-0 font-mono text-muted tabular-nums">{d.date}</span>
                    <div className="h-4 min-w-0 flex-1 rounded bg-slate-100">
                      <div
                        className="h-4 rounded bg-cyan-600/80"
                        style={{ width: `${Math.max(2, Math.round(((d.costUsd || 0) / maxDailyCost) * 100))}%` }}
                        title={fmtUsd(d.costUsd || 0)}
                      />
                    </div>
                    <span className="w-14 shrink-0 text-right font-mono text-slate-600 tabular-nums">{d.calls} calls</span>
                    <span className="w-16 shrink-0 text-right font-mono text-muted tabular-nums">{fmtTokens((d.promptTokens || 0) + (d.completionTokens || 0))} tok</span>
                    <span className="w-16 shrink-0 text-right font-mono font-semibold text-slate-900 tabular-nums">{fmtUsd(d.costUsd || 0)}</span>
                    {d.cachedHits > 0 && (
                      <span className="w-20 shrink-0 text-right font-mono text-xs text-emerald-600 tabular-nums">+{d.cachedHits} cached</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Per-stock table */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted" />
              <h2 className="text-sm font-semibold text-slate-900">Usage per stock</h2>
            </div>
            {bySymbol.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No per-symbol usage in this window.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-muted">
                      <th className="py-2 pr-4">Symbol</th>
                      <th className="py-2 pr-4 text-right">Analyses</th>
                      <th className="py-2 pr-4 text-right">Tokens</th>
                      <th className="py-2 pr-4 text-right">Cache hits</th>
                      <th className="py-2 pr-4 text-right">Cost</th>
                      <th className="py-2 text-right">Last analyzed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bySymbol.map((s) => (
                      <tr key={s.symbol} className="border-b border-slate-50 last:border-0">
                        <td className="py-2 pr-4 font-mono font-bold text-slate-900">{s.symbol}</td>
                        <td className="py-2 pr-4 text-right font-mono text-slate-600 tabular-nums">{s.analyses}</td>
                        <td className="py-2 pr-4 text-right font-mono text-slate-600 tabular-nums">{fmtTokens(s.tokens || 0)}</td>
                        <td className="py-2 pr-4 text-right font-mono text-emerald-600 tabular-nums">{s.cachedHits || 0}</td>
                        <td className="py-2 pr-4 text-right font-mono font-semibold text-slate-900 tabular-nums">{fmtUsd(s.costUsd || 0)}</td>
                        <td className="py-2 text-right font-mono text-muted tabular-nums">{s.lastAnalyzed ? fmtTime(s.lastAnalyzed) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recent calls */}
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted" />
              <h2 className="text-sm font-semibold text-slate-900">Recent LLM calls</h2>
            </div>
            {recent.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No calls recorded yet.</p>
            ) : (
              <div className="mt-3 divide-y divide-slate-50">
                {recent.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 text-xs">
                    <span className="w-32 shrink-0 font-mono text-muted tabular-nums">{fmtTime(c.ts)}</span>
                    <span className="w-16 shrink-0 font-mono font-bold text-slate-900">{c.symbol || '—'}</span>
                    <span className="hidden w-24 shrink-0 rounded bg-slate-50 px-1.5 py-0.5 text-center text-xs font-mono text-muted border border-slate-100 sm:block">{c.context}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted">{c.model}</span>
                    {c.cachedHit ? (
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-600 border border-emerald-100">cache hit · $0</span>
                    ) : (
                      <span className="w-28 shrink-0 text-right font-mono text-slate-600 tabular-nums">{fmtTokens((c.promptTokens || 0) + (c.completionTokens || 0))} tok</span>
                    )}
                    <span className={`w-16 shrink-0 text-right font-mono font-semibold tabular-nums ${c.cachedHit ? 'text-emerald-600' : 'text-slate-900'}`}>{fmtUsd(c.costUsd || 0)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
