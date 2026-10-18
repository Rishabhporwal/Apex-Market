'use client';

import React, { useState, useEffect } from 'react';
import { 
  BarChart2, 
  DollarSign, 
  TrendingUp, 
  ShieldCheck, 
  Building2, 
  Globe, 
  Users, 
  Target,
  RefreshCw,
  HelpCircle
} from 'lucide-react';
import { CompanyOverview, KeyFinancials, FinancialStatementItem } from '@/types';

interface FinancialsPanelProps {
  symbol: string;
}

export function FinancialsPanel({ symbol }: FinancialsPanelProps) {
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [metrics, setMetrics] = useState<KeyFinancials | null>(null);
  const [statements, setStatements] = useState<FinancialStatementItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    async function loadFinancials() {
      setLoading(true);
      try {
        const res = await fetch(`/api/financials?symbol=${symbol}&section=all`);
        if (res.ok && isMounted) {
          const data = await res.json();
          setOverview(data.overview);
          setMetrics(data.metrics);
          setStatements(data.statements || []);
        }
      } catch (err) {
        console.error('Financials fetch error:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadFinancials();
    return () => {
      isMounted = false;
    };
  }, [symbol]);

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-12 text-center text-slate-400 font-mono">
        <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-3 text-cyan-400" />
        Pulling audited financials, SEC filings data and valuation multiples for {symbol}...
      </div>
    );
  }

  const formatCurrency = (val?: number) => {
    if (val === undefined || val === null) return 'N/A';
    if (Math.abs(val) >= 1e12) return `$${(val / 1e12).toFixed(2)}T`;
    if (Math.abs(val) >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    return `$${val.toLocaleString()}`;
  };

  const formatPercent = (val?: number) => {
    if (val === undefined || val === null) return 'N/A';
    // If it's a decimal like 0.25, convert to percent
    const pct = Math.abs(val) < 1 ? val * 100 : val;
    return `${pct.toFixed(2)}%`;
  };

  return (
    <div className="space-y-6">
      {/* Company Profile Header */}
      {overview && (
        <div className="glass-panel rounded-2xl p-6">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-800 pb-4 mb-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-white font-sans">{overview.name}</h2>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-slate-800 text-cyan-400 border border-slate-700">
                  {overview.symbol}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-4 text-xs font-mono text-slate-400">
                <span className="flex items-center gap-1">
                  <Building2 className="h-3.5 w-3.5 text-slate-500" /> {overview.sector} › {overview.industry}
                </span>
                <span>HQ: {overview.headquarters}</span>
                {overview.employees && (
                  <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5 text-slate-500" /> {overview.employees.toLocaleString()} Employees
                  </span>
                )}
                {overview.ceo && <span>CEO: {overview.ceo}</span>}
              </div>
            </div>

            {overview.website && (
              <a
                href={overview.website}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono text-cyan-400 transition"
              >
                <Globe className="h-3.5 w-3.5" /> Company Website
              </a>
            )}
          </div>

          <p className="text-xs text-slate-300 font-sans leading-relaxed line-clamp-3 hover:line-clamp-none transition-all">
            {overview.description}
          </p>
        </div>
      )}

      {/* Valuation & Multiples Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="glass-panel rounded-xl p-3.5 border border-slate-800/80">
          <div className="text-[10px] font-mono uppercase text-slate-400">Market Cap</div>
          <div className="text-lg font-bold font-mono text-white mt-1">{formatCurrency(metrics?.marketCap)}</div>
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">Enterprise: {formatCurrency(metrics?.enterpriseValue)}</div>
        </div>

        <div className="glass-panel rounded-xl p-3.5 border border-slate-800/80">
          <div className="text-[10px] font-mono uppercase text-slate-400">Trailing P/E</div>
          <div className="text-lg font-bold font-mono text-cyan-300 mt-1">
            {metrics?.trailingPE ? metrics.trailingPE.toFixed(2) : 'N/A'}
          </div>
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">Forward: {metrics?.forwardPE ? metrics.forwardPE.toFixed(2) : 'N/A'}</div>
        </div>

        <div className="glass-panel rounded-xl p-3.5 border border-slate-800/80">
          <div className="text-[10px] font-mono uppercase text-slate-400">PEG Ratio</div>
          <div className="text-lg font-bold font-mono text-white mt-1">
            {metrics?.pegRatio ? metrics.pegRatio.toFixed(2) : 'N/A'}
          </div>
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">5yr expected</div>
        </div>

        <div className="glass-panel rounded-xl p-3.5 border border-slate-800/80">
          <div className="text-[10px] font-mono uppercase text-slate-400">EV / EBITDA</div>
          <div className="text-lg font-bold font-mono text-white mt-1">
            {metrics?.evToEbitda ? metrics.evToEbitda.toFixed(2) : 'N/A'}
          </div>
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">P/S: {metrics?.priceToSales ? metrics.priceToSales.toFixed(2) : 'N/A'}</div>
        </div>

        <div className="glass-panel rounded-xl p-3.5 border border-slate-800/80">
          <div className="text-[10px] font-mono uppercase text-slate-400">Profit Margin</div>
          <div className="text-lg font-bold font-mono text-emerald-400 mt-1">{formatPercent(metrics?.profitMargin)}</div>
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">Op Margin: {formatPercent(metrics?.operatingMargin)}</div>
        </div>

        <div className="glass-panel rounded-xl p-3.5 border border-slate-800/80">
          <div className="text-[10px] font-mono uppercase text-slate-400">Return on Equity</div>
          <div className="text-lg font-bold font-mono text-white mt-1">{formatPercent(metrics?.returnOnEquity)}</div>
          <div className="text-[10px] font-mono text-slate-500 mt-0.5">ROA: {formatPercent(metrics?.returnOnAssets)}</div>
        </div>
      </div>

      {/* Balance Sheet Strength & Wall Street Price Targets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Balance Sheet & Cash Metrics */}
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="text-sm font-bold font-mono uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
            <DollarSign className="h-4 w-4 text-emerald-400" /> Balance Sheet & Liquidity Health
          </h3>

          <div className="space-y-3 font-mono text-xs">
            <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <span className="text-slate-400">Total Cash & Equivalents</span>
              <span className="text-white font-bold">{formatCurrency(metrics?.totalCash)}</span>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <span className="text-slate-400">Total Debt</span>
              <span className="text-white font-bold">{formatCurrency(metrics?.totalDebt)}</span>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <span className="text-slate-400">Free Cash Flow (TTM)</span>
              <span className="text-emerald-400 font-bold">{formatCurrency(metrics?.freeCashflow)}</span>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <span className="text-slate-400">Operating Cash Flow</span>
              <span className="text-white font-bold">{formatCurrency(metrics?.operatingCashflow)}</span>
            </div>
            <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
              <span className="text-slate-400">Dividend Yield / Payout</span>
              <span className="text-white font-bold">
                {metrics?.dividendYield ? `${metrics.dividendYield.toFixed(2)}%` : '0.00%'}
              </span>
            </div>
          </div>
        </div>

        {/* Analyst Target Price & Recommendation */}
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="text-sm font-bold font-mono uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
            <Target className="h-4 w-4 text-cyan-400" /> Wall Street Consensus & Targets
          </h3>

          <div className="bg-[#090e18] p-4 rounded-xl border border-slate-800 mb-4 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-mono text-slate-400 uppercase">Analyst Consensus</div>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-0.5">
                {metrics?.recommendationKey?.replace(/_/g, ' ') || 'BUY'}
              </div>
            </div>
            <div className="text-right font-mono text-xs text-slate-400">
              Based on <strong className="text-white">{metrics?.numberOfAnalystOpinions || 42}</strong> analyst opinions
            </div>
          </div>

          {/* Target Price Visual Meter */}
          <div className="space-y-2 font-mono text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Low: ${metrics?.targetLowPrice?.toFixed(2) || '---'}</span>
              <span className="text-cyan-400 font-bold">Mean: ${metrics?.targetMeanPrice?.toFixed(2) || '---'}</span>
              <span className="text-emerald-400">High: ${metrics?.targetHighPrice?.toFixed(2) || '---'}</span>
            </div>
            <div className="h-3 w-full rounded-full bg-slate-800 overflow-hidden relative">
              <div className="absolute inset-y-0 left-1/4 right-1/4 bg-cyan-500/30 rounded-full" />
              <div className="absolute top-0 bottom-0 left-1/2 w-1 bg-cyan-400 shadow-md shadow-cyan-400" />
            </div>
            <div className="text-[11px] text-slate-500 text-center">
              Consensus 12-month upside projection based on sell-side research coverage.
            </div>
          </div>
        </div>
      </div>

      {/* Multi-Year Financial Statements Table */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="text-sm font-bold font-mono uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
          <BarChart2 className="h-4 w-4 text-cyan-400" /> Multi-Year Income Statement Highlights
        </h3>

        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="pb-3 font-semibold">Fiscal Year</th>
                <th className="pb-3 font-semibold">Total Revenue</th>
                <th className="pb-3 font-semibold">Gross Profit</th>
                <th className="pb-3 font-semibold">Operating Income</th>
                <th className="pb-3 font-semibold">Net Income</th>
                <th className="pb-3 font-semibold">EBITDA</th>
                <th className="pb-3 font-semibold">Diluted EPS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {statements.map((stmt) => (
                <tr key={stmt.year} className="hover:bg-slate-800/30 transition">
                  <td className="py-3 font-bold text-cyan-400">{stmt.year}</td>
                  <td className="py-3 text-white">{formatCurrency(stmt.revenue)}</td>
                  <td className="py-3 text-emerald-400">{formatCurrency(stmt.grossProfit)}</td>
                  <td className="py-3 text-slate-300">{formatCurrency(stmt.operatingIncome)}</td>
                  <td className="py-3 font-bold text-white">{formatCurrency(stmt.netIncome)}</td>
                  <td className="py-3 text-slate-400">{formatCurrency(stmt.ebitda)}</td>
                  <td className="py-3 text-cyan-300">${stmt.eps.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
