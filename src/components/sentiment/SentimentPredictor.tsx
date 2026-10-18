'use client';

import React, { useState, useEffect } from 'react';
import { 
  Sparkles, 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  CheckCircle2, 
  ExternalLink, 
  Filter, 
  RefreshCw,
  Clock,
  Layers,
  ShieldAlert,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';
import { SentimentAnalysisResult, NewsArticle } from '@/types';

interface SentimentPredictorProps {
  symbol: string;
}

export function SentimentPredictor({ symbol }: SentimentPredictorProps) {
  const [data, setData] = useState<SentimentAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFilter, setSelectedFilter] = useState<'ALL' | 'BULLISH' | 'BEARISH' | 'NEUTRAL'>('ALL');

  useEffect(() => {
    let isMounted = true;
    async function loadSentiment() {
      setLoading(true);
      try {
        const res = await fetch(`/api/sentiment?symbol=${symbol}`);
        if (res.ok && isMounted) {
          const json = await res.json();
          setData(json);
        }
      } catch (err) {
        console.error('Sentiment fetch error:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadSentiment();
    return () => {
      isMounted = false;
    };
  }, [symbol]);

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-12 text-center text-slate-400 font-mono">
        <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-3 text-cyan-400" />
        Synthesizing news feeds & computing NLP sentiment predictive vectors for {symbol}...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="glass-panel rounded-2xl p-8 text-center text-slate-500 font-mono">
        No sentiment data available for {symbol}.
      </div>
    );
  }

  const { overallScore, sentimentLabel, bullishPercentage, bearishPercentage, neutralPercentage, predictiveInsight, news } = data;

  const filteredNews = news.filter((n) => {
    if (selectedFilter === 'ALL') return true;
    return n.sentiment === selectedFilter;
  });

  const getScoreColor = (score: number) => {
    if (score >= 35) return 'text-emerald-400';
    if (score >= 10) return 'text-emerald-300';
    if (score <= -35) return 'text-rose-400';
    if (score <= -10) return 'text-rose-300';
    return 'text-amber-300';
  };

  const getBadgeStyle = (label: string) => {
    if (label.includes('BULLISH')) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    if (label.includes('BEARISH')) return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  };

  return (
    <div className="space-y-6">
      {/* Top Banner: AI Sentiment & Prediction Engine */}
      <div className="glass-panel rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -left-16 -bottom-16 h-56 w-56 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6 relative z-10">
          {/* Sentiment Meter */}
          <div className="flex items-center gap-6">
            <div className="relative flex h-28 w-28 items-center justify-center rounded-2xl bg-slate-900 border border-slate-700/80 shadow-inner">
              <div className="text-center">
                <div className="text-[10px] uppercase font-mono text-slate-400">Score</div>
                <div className={`text-3xl font-extrabold font-mono ${getScoreColor(overallScore)}`}>
                  {overallScore > 0 ? `+${overallScore}` : overallScore}
                </div>
                <div className="text-[9px] font-mono text-slate-500">Scale -100..+100</div>
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                <span className="text-xs uppercase font-mono font-semibold tracking-wider text-cyan-400">
                  AI News Sentiment Synthesis
                </span>
              </div>
              <div className="mt-1 flex items-center gap-3">
                <h2 className="text-2xl font-bold font-sans text-white">{symbol} Sentiment Analysis</h2>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-mono font-bold border ${getBadgeStyle(sentimentLabel)}`}>
                  {sentimentLabel.replace('_', ' ')}
                </span>
              </div>

              {/* Polarity Breakdown Bar */}
              <div className="mt-3 flex items-center gap-3">
                <div className="h-2.5 w-60 rounded-full bg-slate-800 overflow-hidden flex">
                  <div style={{ width: `${bullishPercentage}%` }} className="bg-emerald-500 transition-all" title={`Bullish: ${bullishPercentage}%`} />
                  <div style={{ width: `${neutralPercentage}%` }} className="bg-slate-500 transition-all" title={`Neutral: ${neutralPercentage}%`} />
                  <div style={{ width: `${bearishPercentage}%` }} className="bg-rose-500 transition-all" title={`Bearish: ${bearishPercentage}%`} />
                </div>
                <div className="flex items-center gap-3 text-xs font-mono">
                  <span className="text-emerald-400">▲ {bullishPercentage}%</span>
                  <span className="text-slate-400">● {neutralPercentage}%</span>
                  <span className="text-rose-400">▼ {bearishPercentage}%</span>
                </div>
              </div>
            </div>
          </div>

          {/* AI Predictive Projection Box */}
          <div className="w-full lg:w-auto bg-[#0a1120] border border-cyan-500/30 rounded-xl p-4 min-w-[300px]">
            <div className="flex items-center justify-between text-xs font-mono mb-2">
              <span className="text-slate-400">Projected Price Drift:</span>
              <span className="text-cyan-400 font-bold">Confidence: {predictiveInsight.confidence}%</span>
            </div>

            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-extrabold font-mono text-cyan-300">
                {predictiveInsight.projectedImpactRangePercent[0] > 0 ? '+' : ''}
                {predictiveInsight.projectedImpactRangePercent[0]}% to{' '}
                {predictiveInsight.projectedImpactRangePercent[1] > 0 ? '+' : ''}
                {predictiveInsight.projectedImpactRangePercent[1]}%
              </span>
              <span className="text-xs font-mono text-slate-400">near-term</span>
            </div>

            <div className="mt-2 text-xs font-mono text-slate-300 flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-cyan-400 animate-ping"></span>
              <span>Bias: <strong className="text-white">{predictiveInsight.bias.replace(/_/g, ' ')}</strong></span>
            </div>
          </div>
        </div>

        {/* AI Research Narrative Summary */}
        <div className="mt-6 border-t border-slate-800 pt-4">
          <p className="text-sm text-slate-300 leading-relaxed font-sans bg-slate-900/60 p-4 rounded-xl border border-slate-800">
            <strong className="text-cyan-400 font-mono mr-2">[AI Executive Intelligence]:</strong>
            {predictiveInsight.rationale}
          </p>
        </div>

        {/* Catalysts & Risks Grid */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-slate-900/50 rounded-xl p-3.5 border border-slate-800">
            <div className="flex items-center gap-2 text-xs font-mono font-bold text-emerald-400 mb-2">
              <CheckCircle2 className="h-4 w-4" /> Primary Identified Catalysts
            </div>
            <ul className="space-y-1.5 text-xs text-slate-300 font-sans">
              {predictiveInsight.topCatalysts.map((cat, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-emerald-500 font-bold">•</span>
                  <span>{cat}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-slate-900/50 rounded-xl p-3.5 border border-slate-800">
            <div className="flex items-center gap-2 text-xs font-mono font-bold text-rose-400 mb-2">
              <ShieldAlert className="h-4 w-4" /> Structural Risk Vectors
            </div>
            <ul className="space-y-1.5 text-xs text-slate-300 font-sans">
              {predictiveInsight.riskFactors.map((rf, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-rose-500 font-bold">•</span>
                  <span>{rf}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Filter & News Feed Section */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4 mb-4">
          <div>
            <h3 className="text-lg font-bold text-white font-sans flex items-center gap-2">
              <span>Verified Market News Stream</span>
              <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded-full">
                {filteredNews.length} articles
              </span>
            </h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Scored by NLP sentiment & financial catalyst classification</p>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs font-mono">
            <Filter className="h-3.5 w-3.5 text-slate-400 ml-1.5" />
            {(['ALL', 'BULLISH', 'BEARISH', 'NEUTRAL'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setSelectedFilter(f)}
                className={`px-3 py-1 rounded-lg transition ${
                  selectedFilter === f
                    ? 'bg-slate-800 text-cyan-400 font-bold border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* News Cards Grid */}
        <div className="space-y-3">
          {filteredNews.map((article) => {
            const isPos = article.sentiment === 'BULLISH';
            const isNeg = article.sentiment === 'BEARISH';
            const timeAgo = Math.max(1, Math.round((Date.now() - article.providerPublishTime) / (1000 * 60 * 60)));

            return (
              <div
                key={article.id}
                className="group p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition hover:bg-slate-900/90 flex flex-col md:flex-row items-start md:items-center justify-between gap-4"
              >
                <div className="space-y-1.5 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                    <span className="font-semibold text-slate-400">{article.publisher}</span>
                    <span className="text-slate-600">•</span>
                    <span className="text-slate-500 flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {timeAgo}h ago
                    </span>

                    {article.catalystCategory && (
                      <span className="bg-slate-800 px-2 py-0.5 rounded text-[10px] text-cyan-300 font-mono uppercase">
                        {article.catalystCategory}
                      </span>
                    )}
                  </div>

                  <h4 className="text-sm font-semibold text-slate-100 group-hover:text-cyan-300 transition-colors leading-snug">
                    <a href={article.link} target="_blank" rel="noreferrer" className="flex items-center gap-1.5">
                      <span>{article.title}</span>
                      <ExternalLink className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity text-cyan-400 shrink-0" />
                    </a>
                  </h4>

                  {article.catalystSummary && (
                    <p className="text-xs text-slate-400 font-sans">{article.catalystSummary}</p>
                  )}
                </div>

                {/* Sentiment Score Pill */}
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <div
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono font-bold border ${
                        isPos
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : isNeg
                          ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}
                    >
                      {isPos ? <ArrowUpRight className="h-3.5 w-3.5" /> : isNeg ? <ArrowDownRight className="h-3.5 w-3.5" /> : null}
                      <span>{article.sentiment}</span>
                      <span className="text-[10px] opacity-75">
                        ({(article.sentimentScore * 100).toFixed(0)})
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-1">
                      Conf: {(article.confidence * 100).toFixed(0)}%
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
