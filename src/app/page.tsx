'use client';

import React, { useState, useEffect } from 'react';
import { Navbar } from '@/components/layout/Navbar';
import { VerdictView } from '@/components/verdict/VerdictView';
import { StockChart } from '@/components/charts/StockChart';
import { DailyReportView } from '@/components/daily/DailyReportView';
import { FinancialsPanel } from '@/components/research/FinancialsPanel';
import { FilingsPanel } from '@/components/research/FilingsPanel';
import { ScreenerView } from '@/components/screener/ScreenerView';
import { DiscoverView } from '@/components/discover/DiscoverView';
import { BacktestView } from '@/components/backtesting/BacktestView';
import { PortfolioView } from '@/components/portfolio/PortfolioView';
import { WatchlistView } from '@/components/watchlist/WatchlistView';
import { FilingQA } from '@/components/research/FilingQA';
import { AiCopilotModal } from '@/components/research/AiCopilotModal';
import { StockQuote } from '@/types';

export default function Home() {
  const [selectedSymbol, setSelectedSymbol] = useState('NVDA');
  const [activeTab, setActiveTab] = useState('discover');
  const [currentQuote, setCurrentQuote] = useState<StockQuote | null>(null);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);

  // Load current quote for active symbol
  const fetchCurrentQuote = async (sym: string) => {
    try {
      const res = await fetch(`/api/market-data?type=quote&symbol=${sym}`);
      if (res.ok) {
        const data = await res.json();
        setCurrentQuote(data);
      }
    } catch (e) {
      console.error('Error fetching active quote:', e);
    }
  };

  useEffect(() => {
    fetchCurrentQuote(selectedSymbol);
    const interval = setInterval(() => {
      fetchCurrentQuote(selectedSymbol);
    }, 15000); // 15s refresh
    return () => clearInterval(interval);
  }, [selectedSymbol]);

  const handleSelectSymbol = (sym: string) => {
    setSelectedSymbol(sym);
  };

  return (
    <div className="min-h-screen bg-[#070b12] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Dynamic Background Glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 -left-40 h-[500px] w-[500px] rounded-full bg-cyan-600/10 blur-[130px]" />
        <div className="absolute top-1/3 -right-40 h-[600px] w-[600px] rounded-full bg-blue-600/10 blur-[150px]" />
        <div className="absolute -bottom-40 left-1/3 h-[500px] w-[500px] rounded-full bg-indigo-600/10 blur-[140px]" />
      </div>

      {/* Navigation Header */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedSymbol={selectedSymbol}
        onSelectSymbol={handleSelectSymbol}
        onOpenAiModal={() => setIsAiModalOpen(true)}
      />

      {/* AI Copilot & Model Config Modal */}
      <AiCopilotModal
        isOpen={isAiModalOpen}
        onClose={() => setIsAiModalOpen(false)}
        symbol={selectedSymbol}
      />

      {/* Main Workspace Content */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 py-6">
        {activeTab === 'discover' && (
          <DiscoverView
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setActiveTab('prediction');
            }}
          />
        )}

        {activeTab === 'prediction' && (
          <VerdictView symbol={selectedSymbol} />
        )}

        {activeTab === 'chart' && (
          <StockChart
            symbol={selectedSymbol}
            quote={currentQuote}
            onRefresh={() => fetchCurrentQuote(selectedSymbol)}
          />
        )}

        {activeTab === 'daily' && (
          <DailyReportView
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setActiveTab('prediction');
            }}
          />
        )}

        {activeTab === 'financials' && (
          <FinancialsPanel symbol={selectedSymbol} />
        )}

        {activeTab === 'filings' && (
          <>
            <FilingsPanel symbol={selectedSymbol} />
            <div className="mt-6">
              <FilingQA symbol={selectedSymbol} />
            </div>
          </>
        )}

        {activeTab === 'screener' && (
          <ScreenerView
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setActiveTab('prediction');
            }}
          />
        )}

        {activeTab === 'backtest' && (
          <BacktestView selectedSymbol={selectedSymbol} />
        )}

        {activeTab === 'portfolio' && (
          <PortfolioView
            activeSymbol={selectedSymbol}
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setActiveTab('prediction');
            }}
          />
        )}

        {activeTab === 'watchlist' && (
          <WatchlistView
            onSelectSymbol={(sym) => {
              setSelectedSymbol(sym);
              setActiveTab('prediction');
            }}
          />
        )}
      </main>

      {/* Global Terminal Footer */}
      <footer className="relative z-10 border-t border-slate-800/80 bg-[#060a10]/90 py-4 px-6 text-xs font-mono text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Services Healthy (9/9 Active)</span>
            </span>
            <span className="text-slate-700">|</span>
            <span>AI Master Prediction • Market Data Engine • Financial Modeling • Sentiment AI • SEC EDGAR • Quant Backtester</span>
          </div>
          <div>
            <span>ApexMarket AI v2.5 • US Equities (NYSE / NASDAQ)</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
