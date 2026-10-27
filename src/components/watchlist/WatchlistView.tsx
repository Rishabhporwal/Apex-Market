'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Star, Bell, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus, Plus, CheckCheck, Clock, CalendarClock } from 'lucide-react';

interface WatchedSymbol {
  symbol: string;
  addedAt: number;
  lastVerdict: { action: string; confidence: number; price: number; checkedAt: number } | null;
}

interface AlertItem {
  id: number;
  symbol: string;
  kind?: string;
  fromAction: string;
  toAction: string;
  confidence: number;
  price: number;
  createdAt: number;
  seen: boolean;
}

const ACTION_STYLES: Record<string, { text: string; bg: string; label: string; Icon: any }> = {
  BUY: { text: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200', label: 'Buy', Icon: TrendingUp },
  SELL: { text: 'text-rose-600', bg: 'bg-rose-50 border-rose-200', label: 'Sell', Icon: TrendingDown },
  HOLD: { text: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', label: 'Hold', Icon: Minus },
  NEUTRAL: { text: 'text-slate-400', bg: 'bg-slate-50 border-slate-200', label: 'Neutral', Icon: Minus },
};

function ActionBadge({ action }: { action: string }) {
  const s = ACTION_STYLES[action] || ACTION_STYLES.NEUTRAL;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-semibold ${s.bg} ${s.text}`}>
      <s.Icon className="h-3 w-3" /> {s.label}
    </span>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function WatchlistView({ onSelectSymbol }: { onSelectSymbol: (sym: string) => void }) {
  const [symbols, setSymbols] = useState<WatchedSymbol[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [unseenCount, setUnseenCount] = useState(0);
  const [newSymbol, setNewSymbol] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [earningsMap, setEarningsMap] = useState<Record<string, { earningsDate: string | null; daysUntil: number | null }>>({});

  const load = useCallback(async () => {
    try {
      const [wlRes, alRes] = await Promise.all([fetch('/api/watchlist'), fetch('/api/alerts')]);
      if (wlRes.ok) {
        const data = await wlRes.json();
        setSymbols(data.symbols || []);
      }
      if (alRes.ok) {
        const data = await alRes.json();
        setAlerts(data.alerts || []);
        setUnseenCount(data.unseenCount || 0);
      }
      setError(null);
    } catch (e) {
      setError('Could not load watchlist');
    } finally {
      setLoading(false);
    }
  }, []);

  // Earnings-calendar per watched symbol (badge on each card). Kept cheap:
  // one parallel batch per watchlist load, capped, failures silently skipped.
  const loadEarnings = useCallback(async (list: WatchedSymbol[]) => {
    const targets = list.slice(0, 30);
    const results = await Promise.allSettled(
      targets.map((s) => fetch(`/api/earnings?symbol=${encodeURIComponent(s.symbol)}`).then((r) => (r.ok ? r.json() : null)))
    );
    const map: Record<string, { earningsDate: string | null; daysUntil: number | null }> = {};
    results.forEach((r, i) => {
      const d = r.status === 'fulfilled' ? r.value : null;
      if (d?.earningsDate) map[targets[i].symbol] = d;
    });
    setEarningsMap(map);
  }, []);

  useEffect(() => {
    if (symbols.length) void loadEarnings(symbols);
  }, [symbols, loadEarnings]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000); // refresh every minute
    return () => clearInterval(interval);
  }, [load]);

  const addSymbol = async () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    setAdding(true);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: sym }),
      });
      if (res.ok) {
        const data = await res.json();
        setSymbols(data.symbols || []);
        setNewSymbol('');
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Could not add symbol');
      }
    } finally {
      setAdding(false);
    }
  };

  const removeSymbol = async (sym: string) => {
    const res = await fetch(`/api/watchlist?symbol=${encodeURIComponent(sym)}`, { method: 'DELETE' });
    if (res.ok) {
      const data = await res.json();
      setSymbols(data.symbols || []);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await fetch('/api/watchlist/check-now', { method: 'POST' });
      await load();
    } finally {
      setChecking(false);
    }
  };

  const markAllSeen = async () => {
    const ids = alerts.filter((a) => !a.seen).map((a) => a.id);
    if (!ids.length) return;
    await fetch('/api/alerts/seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    setAlerts((prev) => prev.map((a) => (ids.includes(a.id) ? { ...a, seen: true } : a)));
    setUnseenCount(0);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Star className="h-6 w-6 text-amber-600" /> Your Watchlist
              {unseenCount > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-cyan-50 border border-cyan-200 px-2.5 py-0.5 text-xs font-bold text-cyan-700">
                  {unseenCount} new alert{unseenCount > 1 ? 's' : ''}
                </span>
              )}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Track companies you care about. The AI re-checks every verdict every 5 minutes and flags you the moment a rating changes.
            </p>
          </div>
          <button
            onClick={checkNow}
            disabled={checking || symbols.length === 0}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 hover:border-cyan-200 hover:text-cyan-700 text-slate-400 text-sm transition disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'Checking verdicts…' : 'Check now'}
          </button>
        </div>

        {/* Add symbol */}
        <div className="mt-4 flex gap-2 max-w-md">
          <input
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
            placeholder="Add a ticker — e.g. TSLA"
            maxLength={10}
            className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-cyan-200"
          />
          <button
            onClick={addSymbol}
            disabled={adding || !newSymbol.trim()}
            className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-cyan-50 border border-cyan-200 text-cyan-700 text-sm font-semibold hover:bg-cyan-50 transition disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
      </div>

      {loading ? (
        <div className="glass-panel rounded-2xl p-10 text-center text-slate-500">Loading your watchlist…</div>
      ) : (
        <>
          {/* Watched symbols grid */}
          <div>
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Tracked companies ({symbols.length})</h2>
            {symbols.length === 0 ? (
              <div className="glass-panel rounded-2xl p-10 text-center text-slate-500">
                <Star className="h-8 w-8 mx-auto mb-3 text-slate-400" />
                Nothing tracked yet. Add a ticker above, or hit the ☆ on any AI Verdict page.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {symbols.map((s) => (
                  <div key={s.symbol} className="glass-panel rounded-xl p-4 group hover:border-cyan-200 transition">
                    <div className="flex items-start justify-between">
                      <button
                        onClick={() => s.lastVerdict && onSelectSymbol(s.symbol)}
                        className="text-left"
                      >
                        <div className="font-bold text-slate-900 text-lg">{s.symbol}</div>
                        {s.lastVerdict ? (
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <ActionBadge action={s.lastVerdict.action} />
                            <span className="text-xs text-slate-500">{s.lastVerdict.confidence}% confidence</span>
                          </div>
                        ) : (
                          <div className="mt-2 text-xs text-slate-500">No verdict checked yet — hit “Check now”</div>
                        )}
                      </button>
                      <button
                        onClick={() => removeSymbol(s.symbol)}
                        title={`Remove ${s.symbol}`}
                        className="opacity-0 group-hover:opacity-100 transition text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    {s.lastVerdict && (
                      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                        <span className="flex items-center gap-2">
                          {s.lastVerdict.price != null ? `$${s.lastVerdict.price.toFixed(2)}` : '—'}
                          {(() => {
                            const e = earningsMap[s.symbol];
                            if (!e || e.daysUntil == null || e.daysUntil > 21 || e.daysUntil < -1) return null;
                            return (
                              <span
                                title={`Earnings ${e.daysUntil <= 0 ? 'imminent' : `in ${e.daysUntil} day${e.daysUntil === 1 ? '' : 's'}`} — verdicts can shift sharply around reports`}
                                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${e.daysUntil <= 7 ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}
                              >
                                <CalendarClock className="h-3 w-3" /> ER {e.daysUntil <= 0 ? 'now' : `${e.daysUntil}d`}
                              </span>
                            );
                          })()}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> checked {timeAgo(s.lastVerdict.checkedAt)}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Alert feed */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                <Bell className="h-4 w-4" /> Alerts
              </h2>
              {unseenCount > 0 && (
                <button onClick={markAllSeen} className="inline-flex items-center gap-1 text-xs text-cyan-600 hover:text-cyan-700">
                  <CheckCheck className="h-3.5 w-3.5" /> Mark all as seen
                </button>
              )}
            </div>
            {alerts.length === 0 ? (
              <div className="glass-panel rounded-2xl p-8 text-center text-slate-500 text-sm">
                No alerts yet. Verdict flips land here — and stocks you flagged &ldquo;notify me when tradable&rdquo; ping you the moment they get a valid plan.
              </div>
            ) : (
              <div className="glass-panel rounded-2xl divide-y divide-slate-200">
                {alerts.map((a) => {
                  const tint = !a.seen
                    ? a.kind === 'pin_at_risk' ? 'bg-rose-50' : a.kind === 'became_tradable' ? 'bg-emerald-50' : 'bg-cyan-50'
                    : '';
                  const dot = a.kind === 'pin_at_risk' ? 'bg-rose-400' : a.kind === 'became_tradable' ? 'bg-emerald-400' : 'bg-cyan-400';
                  return (
                  <div key={a.id} className={`p-4 flex items-center gap-4 flex-wrap ${tint}`}>
                    {!a.seen && <span className={`h-2 w-2 rounded-full shrink-0 ${dot}`} title="New" />}
                    <button onClick={() => onSelectSymbol(a.symbol)} className="font-bold text-slate-900 hover:text-cyan-700">
                      {a.symbol}
                    </button>
                    {a.kind === 'pin_at_risk' ? (
                      <>
                        <span className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-full px-2 py-0.5">
                          position at risk — still holding
                        </span>
                        <span className="text-xs text-rose-500">{a.toAction}</span>
                        <span className="text-[10px] text-slate-400">pinned as {a.fromAction}</span>
                      </>
                    ) : a.kind === 'became_tradable' ? (
                      <>
                        <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                          now tradable
                        </span>
                        <span className="text-xs text-emerald-600">{a.toAction}</span>
                        {a.confidence != null && <span className="text-[10px] text-slate-400">{a.confidence}% conf</span>}
                      </>
                    ) : (
                      <div className="flex items-center gap-2">
                        <ActionBadge action={a.fromAction} />
                        <span className="text-slate-400">&rarr;</span>
                        <ActionBadge action={a.toAction} />
                      </div>
                    )}
                    {a.kind !== 'became_tradable' && a.price != null && <span className="text-xs text-slate-500">@ ${a.price?.toFixed(2)}{a.confidence ? ` · ${a.confidence}% conf` : ''}</span>}
                    <span className="ml-auto text-xs text-slate-400">{timeAgo(a.createdAt)}</span>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
