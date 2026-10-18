'use client';

import React, { useState, useEffect } from 'react';
import { 
  Target, 
  ShieldAlert, 
  Sparkles, 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  CheckCircle2, 
  AlertTriangle, 
  ArrowUpRight, 
  ArrowDownRight, 
  Layers, 
  Compass, 
  RefreshCw,
  Clock,
  Briefcase
} from 'lucide-react';
import { FinalStockPrediction } from '@/types';

interface FinalPredictionCardProps {
  symbol: string;
  onOpenTrade?: (symbol: string, type: 'BUY' | 'SELL') => void;
}

export function FinalPredictionCard({ symbol, onOpenTrade }: FinalPredictionCardProps) {
  const [prediction, setPrediction] = useState<FinalStockPrediction | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDimension, setSelectedDimension] = useState<
    'technicalChart' | 'newsSentiment' | 'fundamentalsValuation' | 'secRegulatoryFilings'
  >('technicalChart');

  const fetchPrediction = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/prediction?symbol=${symbol}`);
      if (res.ok) {
        const data = await res.json();
        setPrediction(data);
      }
    } catch (err) {
      console.error('Failed to load final prediction:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrediction();
  }, [symbol]);

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-12 text-center text-slate-400 font-mono">
        <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-3 text-cyan-400" />
        Synthesizing Chart Technicals, News Sentiment, Fundamentals, and SEC Regulatory Research for {symbol}...
      </div>
    );
  }

  if (!prediction) {
    return (
      <div className="glass-panel rounded-2xl p-8 text-center text-slate-500 font-mono">
        Unable to compute prediction synthesis for {symbol}.
      </div>
    );
  }

  const {
    recommendation,
    confidenceScore,
    timeHorizon,
    synthesisRationale,
    priceTargets,
    dimensions,
    invalidationTrigger,
    tradeExecutionSummary,
  } = prediction;

  const isBullish = recommendation === 'STRONG_BUY' || recommendation === 'BUY';
  const isBearish = recommendation === 'STRONG_SELL' || recommendation === 'SELL';

  const getRecBadge = () => {
    switch (recommendation) {
      case 'STRONG_BUY':
        return {
          text: 'STRONG BUY',
          bg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-emerald-500/20 shadow-lg',
          icon: TrendingUp,
        };
      case 'BUY':
        return {
          text: 'BUY / ACCUMULATE',
          bg: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
          icon: TrendingUp,
        };
      case 'STRONG_SELL':
        return {
          text: 'STRONG SELL',
          bg: 'bg-rose-500/20 text-rose-300 border-rose-500/50 shadow-rose-500/20 shadow-lg',
          icon: TrendingDown,
        };
      case 'SELL':
        return {
          text: 'SELL / REDUCE',
          bg: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
          icon: TrendingDown,
        };
      default:
        return {
          text: 'HOLD / NEUTRAL',
          bg: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
          icon: Compass,
        };
    }
  };

  const badge = getRecBadge();
  const Icon = badge.icon;

  return (
    <div className="space-y-6">
      {/* Master Recommendation Hero Panel */}
      <div className="glass-panel rounded-2xl p-6 relative overflow-hidden border border-slate-700/80">
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-blue-600/10 blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6 border-b border-slate-800 pb-6">
          <div className="flex items-center gap-5">
            <div
              className={`flex h-20 w-20 items-center justify-center rounded-2xl border ${
                isBullish
                  ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400'
                  : isBearish
                  ? 'bg-rose-950/60 border-rose-500/40 text-rose-400'
                  : 'bg-amber-950/60 border-amber-500/40 text-amber-400'
              }`}
            >
              <Icon className="h-10 w-10" />
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono uppercase font-bold tracking-wider text-cyan-400">
                  Comprehensive Synthesis Model
                </span>
                <span className="text-slate-600">•</span>
                <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Live
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl sm:text-3xl font-extrabold font-mono text-white tracking-tight">
                  {symbol}
                </h2>
                <div className={`px-4 py-1.5 rounded-xl font-mono text-sm font-extrabold border ${badge.bg}`}>
                  {badge.text}
                </div>
              </div>

              <p className="text-xs text-slate-400 font-mono mt-1">
                Horizon: <strong className="text-slate-200">{timeHorizon}</strong>
              </p>
            </div>
          </div>

          {/* Model Confidence & Risk/Reward Pill */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="bg-[#090e18] p-3 rounded-xl border border-slate-800 text-center min-w-[120px]">
              <div className="text-[10px] font-mono text-slate-400 uppercase">Confidence Score</div>
              <div className="text-xl font-extrabold font-mono text-cyan-300 mt-0.5">{confidenceScore}%</div>
              <div className="text-[9px] font-mono text-slate-500">4-Vector Confluence</div>
            </div>

            <div className="bg-[#090e18] p-3 rounded-xl border border-slate-800 text-center min-w-[120px]">
              <div className="text-[10px] font-mono text-slate-400 uppercase">Risk / Reward</div>
              <div className="text-xl font-extrabold font-mono text-emerald-400 mt-0.5">
                1 : {priceTargets.riskRewardRatio}
              </div>
              <div className="text-[9px] font-mono text-slate-500">Asymmetric Skew</div>
            </div>

            {onOpenTrade && (
              <button
                onClick={() => onOpenTrade(symbol, isBullish ? 'BUY' : 'SELL')}
                className={`flex items-center gap-2 px-4 py-3 rounded-xl font-mono text-xs font-bold transition shadow-lg ${
                  isBullish
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/25'
                    : 'bg-rose-500 hover:bg-rose-400 text-slate-950 shadow-rose-500/25'
                }`}
              >
                <Briefcase className="h-4 w-4" />
                <span>Trade in Sandbox</span>
              </button>
            )}
          </div>
        </div>

        {/* Master Synthesis Rationale */}
        <div className="mt-5 space-y-3">
          <div className="text-xs font-mono font-bold uppercase text-slate-400 flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-cyan-400" /> Executive Research Rationale
          </div>
          <p className="text-xs sm:text-sm text-slate-200 font-sans leading-relaxed bg-slate-900/70 p-4 rounded-xl border border-slate-800">
            {synthesisRationale}
          </p>
        </div>
      </div>

      {/* Target Prices & Numerical Key Levels Grid */}
      <div className="glass-panel rounded-2xl p-6">
        <h3 className="text-sm font-bold font-mono uppercase tracking-wider text-slate-300 flex items-center gap-2 mb-4">
          <Target className="h-4 w-4 text-cyan-400" /> Actionable Numerical Targets & Capital Preservation Limits
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono">
          {/* Current Price */}
          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <div className="text-[10px] text-slate-400 uppercase">Market Price</div>
            <div className="text-lg font-bold text-white mt-1">${priceTargets.currentPrice.toFixed(2)}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Reference baseline</div>
          </div>

          {/* Entry Zone */}
          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-cyan-500/30">
            <div className="text-[10px] text-cyan-400 uppercase font-bold">Recommended Entry</div>
            <div className="text-sm font-bold text-cyan-200 mt-1">
              ${priceTargets.entryZone[0].toFixed(2)} - ${priceTargets.entryZone[1].toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">Optimal fill channel</div>
          </div>

          {/* Target 1 */}
          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-emerald-500/20">
            <div className="text-[10px] text-emerald-400 uppercase font-bold">Target 1 (Conservative)</div>
            <div className="text-lg font-bold text-emerald-300 mt-1">${priceTargets.target1.price.toFixed(2)}</div>
            <div className="text-[10px] font-bold text-emerald-400 mt-0.5">
              {priceTargets.target1.upsidePercent >= 0 ? '+' : ''}{priceTargets.target1.upsidePercent}%
            </div>
          </div>

          {/* Target 2 */}
          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-emerald-500/30">
            <div className="text-[10px] text-emerald-400 uppercase font-bold">Target 2 (Base Case)</div>
            <div className="text-lg font-bold text-emerald-300 mt-1">${priceTargets.target2.price.toFixed(2)}</div>
            <div className="text-[10px] font-bold text-emerald-400 mt-0.5">
              {priceTargets.target2.upsidePercent >= 0 ? '+' : ''}{priceTargets.target2.upsidePercent}%
            </div>
          </div>

          {/* Target 3 */}
          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-emerald-500/40">
            <div className="text-[10px] text-emerald-400 uppercase font-bold">Target 3 (Extension)</div>
            <div className="text-lg font-bold text-emerald-200 mt-1">${priceTargets.target3.price.toFixed(2)}</div>
            <div className="text-[10px] font-bold text-emerald-400 mt-0.5">
              {priceTargets.target3.upsidePercent >= 0 ? '+' : ''}{priceTargets.target3.upsidePercent}%
            </div>
          </div>

          {/* Stop Loss */}
          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-rose-500/30">
            <div className="text-[10px] text-rose-400 uppercase font-bold">Stop Loss (Hard Exit)</div>
            <div className="text-lg font-bold text-rose-300 mt-1">${priceTargets.stopLoss.price.toFixed(2)}</div>
            <div className="text-[10px] font-bold text-rose-400 mt-0.5">
              -{priceTargets.stopLoss.riskPercent}% max risk
            </div>
          </div>
        </div>

        {/* Supports & Resistances Numerical Grid */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs">
          {/* Key Support Levels */}
          <div className="p-4 rounded-xl bg-[#080d16] border border-slate-800">
            <div className="text-xs font-bold text-emerald-400 mb-2 flex items-center gap-1.5">
              <ArrowDownRight className="h-4 w-4" /> Mathematical Support Floors
            </div>
            <div className="space-y-1.5">
              {priceTargets.supports.map((s, idx) => (
                <div key={idx} className="flex items-center justify-between p-2 rounded bg-slate-900/50 border border-slate-800/60">
                  <span className="font-bold text-slate-300">{s.level} Primary Base</span>
                  <span className="text-emerald-400 font-bold">${s.price.toFixed(2)}</span>
                  <span className="text-[10px] text-slate-500 uppercase">{s.strength} Strength</span>
                </div>
              ))}
            </div>
          </div>

          {/* Key Resistance Levels */}
          <div className="p-4 rounded-xl bg-[#080d16] border border-slate-800">
            <div className="text-xs font-bold text-rose-400 mb-2 flex items-center gap-1.5">
              <ArrowUpRight className="h-4 w-4" /> Overhead Resistance Ceilings
            </div>
            <div className="space-y-1.5">
              {priceTargets.resistances.map((r, idx) => (
                <div key={idx} className="flex items-center justify-between p-2 rounded bg-slate-900/50 border border-slate-800/60">
                  <span className="font-bold text-slate-300">{r.level} Ceiling Barrier</span>
                  <span className="text-rose-400 font-bold">${r.price.toFixed(2)}</span>
                  <span className="text-[10px] text-slate-500 uppercase">{r.strength} Strength</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Execution & Invalidation Rules */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-sans">
          <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800">
            <div className="font-mono font-bold text-cyan-400 uppercase text-[11px] mb-1 flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" /> Execution Blueprint
            </div>
            <p className="text-slate-300 leading-relaxed">{tradeExecutionSummary}</p>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/60 border border-amber-500/30">
            <div className="font-mono font-bold text-amber-400 uppercase text-[11px] mb-1 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" /> Invalidation Criteria
            </div>
            <p className="text-slate-300 leading-relaxed">{invalidationTrigger}</p>
          </div>
        </div>
      </div>

      {/* 4-Dimensional Detailed Reasons & Deep Dive */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-4">
          <div>
            <h3 className="text-sm font-bold font-mono uppercase tracking-wider text-white">
              Multi-Dimensional Reasoning Breakdown
            </h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              Why the model recommends this prediction across all 4 research dimensions
            </p>
          </div>

          {/* Dimension Selector Tabs */}
          <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs font-mono">
            {[
              { id: 'technicalChart', label: '📊 Technical Chart' },
              { id: 'newsSentiment', label: '📰 News Sentiment' },
              { id: 'fundamentalsValuation', label: '🏛️ Fundamentals' },
              { id: 'secRegulatoryFilings', label: '📑 SEC Filings' },
            ].map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedDimension(d.id as any)}
                className={`px-2.5 py-1 rounded-lg transition ${
                  selectedDimension === d.id
                    ? 'bg-slate-800 text-cyan-400 font-bold border border-slate-700'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {/* Selected Dimension Detail Box */}
        {(() => {
          const currentDim = dimensions[selectedDimension];
          const isDimBullish = currentDim.verdict === 'BULLISH';
          const isDimBearish = currentDim.verdict === 'BEARISH';

          return (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                <div>
                  <div className="text-[10px] font-mono uppercase text-slate-400">Dimension Score</div>
                  <div className={`text-2xl font-bold font-mono mt-0.5 ${currentDim.score >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {currentDim.score > 0 ? `+${currentDim.score}` : currentDim.score} / 100
                  </div>
                </div>

                <div
                  className={`px-3 py-1 rounded-lg text-xs font-mono font-bold border ${
                    isDimBullish
                      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                      : isDimBearish
                      ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                      : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  }`}
                >
                  Verdict: {currentDim.verdict}
                </div>
              </div>

              <div className="bg-[#090e18] p-4 rounded-xl border border-slate-800 text-xs font-sans text-slate-200 leading-relaxed">
                <strong className="text-cyan-400 font-mono mr-1.5">[Dimension Synopsis]:</strong>
                {currentDim.summary}
              </div>

              <div>
                <div className="text-xs font-mono font-bold uppercase text-slate-400 mb-2">
                  Key Supporting Evidence & Empirical Data Points
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {currentDim.keyDrivers.map((driver, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-2 p-3 rounded-xl bg-slate-900/50 border border-slate-800/80 text-xs text-slate-300 font-sans"
                    >
                      <span className="text-cyan-400 font-bold mt-0.5">•</span>
                      <span>{driver}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
