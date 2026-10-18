'use client';

import React, { useState, useEffect } from 'react';
import { 
  FileText, 
  ExternalLink, 
  Sparkles, 
  CheckCircle2, 
  AlertCircle, 
  TrendingUp, 
  RefreshCw,
  Calendar,
  Layers
} from 'lucide-react';
import { SecFiling, EarningsTranscriptHighlight } from '@/types';

interface FilingsPanelProps {
  symbol: string;
}

export function FilingsPanel({ symbol }: FilingsPanelProps) {
  const [filings, setFilings] = useState<SecFiling[]>([]);
  const [transcripts, setTranscripts] = useState<EarningsTranscriptHighlight[]>([]);
  const [activeSubTab, setActiveSubTab] = useState<'transcripts' | 'filings'>('transcripts');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    async function loadFilingsData() {
      setLoading(true);
      try {
        const res = await fetch(`/api/filings?symbol=${symbol}&type=all`);
        if (res.ok && isMounted) {
          const data = await res.json();
          setFilings(data.filings || []);
          setTranscripts(data.transcripts || []);
        }
      } catch (err) {
        console.error('Filings fetch error:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadFilingsData();
    return () => {
      isMounted = false;
    };
  }, [symbol]);

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-12 text-center text-slate-400 font-mono">
        <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-3 text-cyan-400" />
        Retrieving SEC EDGAR filings & parsing earnings call transcripts for {symbol}...
      </div>
    );
  }

  const getFilingBadgeColor = (type: string) => {
    if (type.includes('10-K')) return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
    if (type.includes('10-Q')) return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
    if (type.includes('8-K')) return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
  };

  return (
    <div className="space-y-6">
      {/* Sub-tab Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <button
          onClick={() => setActiveSubTab('transcripts')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono font-medium transition ${
            activeSubTab === 'transcripts'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
          }`}
        >
          <Sparkles className="h-4 w-4 text-cyan-400" />
          <span>Earnings Call Transcripts & Breakdown</span>
        </button>

        <button
          onClick={() => setActiveSubTab('filings')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono font-medium transition ${
            activeSubTab === 'filings'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
              : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
          }`}
        >
          <FileText className="h-4 w-4 text-cyan-400" />
          <span>SEC EDGAR Filings (10-K, 10-Q, 8-K)</span>
        </button>
      </div>

      {/* Transcripts Breakdown View */}
      {activeSubTab === 'transcripts' && (
        <div className="space-y-6">
          {transcripts.map((t, idx) => (
            <div key={idx} className="glass-panel rounded-2xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-white font-sans">{symbol} Earnings Call: {t.quarter}</h3>
                    <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2.5 py-0.5 rounded-full">
                      {t.date}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-1">Management Conference Call & Prepared Remarks Analysis</p>
                </div>

                <div className="flex items-center gap-3 font-mono text-xs">
                  {t.revenueSurprisePercent !== undefined && (
                    <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                      Revenue Surprise: <strong className="font-bold">+{t.revenueSurprisePercent}%</strong>
                    </div>
                  )}
                  {t.epsSurprisePercent !== undefined && (
                    <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                      EPS Beat: <strong className="font-bold">+{t.epsSurprisePercent}%</strong>
                    </div>
                  )}
                </div>
              </div>

              {/* Executive Summary */}
              <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800/80">
                <div className="text-[11px] font-mono uppercase text-cyan-400 font-bold mb-1">
                  Executive Briefing & Tone
                </div>
                <p className="text-xs text-slate-300 leading-relaxed font-sans">{t.executiveSummary}</p>
              </div>

              {/* Positive Drivers vs Headwinds Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-900/40 p-4 rounded-xl border border-emerald-500/20">
                  <div className="flex items-center gap-2 text-xs font-mono font-bold text-emerald-400 mb-2">
                    <CheckCircle2 className="h-4 w-4" /> Operational Highlights & Strengths
                  </div>
                  <ul className="space-y-2 text-xs text-slate-300 font-sans">
                    {t.positiveHighlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-emerald-400 font-bold">•</span>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-slate-900/40 p-4 rounded-xl border border-amber-500/20">
                  <div className="flex items-center gap-2 text-xs font-mono font-bold text-amber-400 mb-2">
                    <AlertCircle className="h-4 w-4" /> Disclosed Headwinds & Supply Constraints
                  </div>
                  <ul className="space-y-2 text-xs text-slate-300 font-sans">
                    {t.concernsOrHeadwinds.map((c, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-amber-400 font-bold">•</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Forward Guidance Box */}
              <div className="bg-[#090e18] p-4 rounded-xl border border-slate-800">
                <div className="text-[11px] font-mono uppercase text-cyan-400 font-bold mb-1 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" /> Forward Looking Outlook & Financial Guidance
                </div>
                <p className="text-xs text-slate-300 font-sans leading-relaxed">{t.futureGuidance}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SEC Filings List View */}
      {activeSubTab === 'filings' && (
        <div className="glass-panel rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-base font-bold text-white font-sans">Official SEC EDGAR Regulatory Filings</h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Direct verifiable submissions to the U.S. Securities and Exchange Commission</p>
            </div>
            <a
              href={`https://www.sec.gov/edgar/searchedgar/companysearch?company=${symbol}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs font-mono text-cyan-400 hover:text-cyan-300 transition"
            >
              <span>View full SEC EDGAR Index</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          <div className="space-y-3">
            {filings.map((filing) => (
              <div
                key={filing.id}
                className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition flex flex-col md:flex-row items-start md:items-center justify-between gap-4"
              >
                <div className="space-y-1.5 flex-1">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold border ${getFilingBadgeColor(filing.type)}`}>
                      {filing.type}
                    </span>
                    <span className="text-xs font-mono text-slate-400 flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5 text-slate-500" /> Filed: {filing.date}
                    </span>
                    {filing.periodEnd && (
                      <span className="text-xs font-mono text-slate-500">Period End: {filing.periodEnd}</span>
                    )}
                  </div>

                  <h4 className="text-sm font-semibold text-slate-100 font-sans">{filing.title}</h4>

                  {filing.keyPoints && (
                    <div className="mt-2 space-y-1 text-xs text-slate-400 font-sans">
                      {filing.keyPoints.map((pt, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <span className="text-cyan-400">›</span>
                          <span>{pt}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <a
                  href={filing.edgarUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono font-medium text-cyan-300 border border-slate-700 transition shrink-0"
                >
                  <span>Read on SEC.gov</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
