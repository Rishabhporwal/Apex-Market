'use client';

import React, { useState, useEffect } from 'react';
import { 
  Zap, 
  TrendingUp, 
  Activity, 
  Play, 
  ShieldCheck, 
  AlertCircle, 
  BarChart2, 
  RefreshCw,
  Sliders,
  CheckCircle,
  HelpCircle
} from 'lucide-react';
import { BacktestParams, BacktestResult } from '@/types';

interface BacktestViewProps {
  selectedSymbol: string;
}

export function BacktestView({ selectedSymbol }: BacktestViewProps) {
  const [symbol, setSymbol] = useState(selectedSymbol);
  const [strategy, setStrategy] = useState<BacktestParams['strategy']>('MA_CROSSOVER');
  const [timeframe, setTimeframe] = useState<BacktestParams['timeframe']>('1y');
  const [initialCapital, setInitialCapital] = useState<number>(10000);

  // Strategy specific parameters
  const [fastPeriod, setFastPeriod] = useState<number>(50);
  const [slowPeriod, setSlowPeriod] = useState<number>(200);
  const [rsiOversold, setRsiOversold] = useState<number>(30);
  const [rsiOverbought, setRsiOverbought] = useState<number>(70);
  const [stopLossPercent, setStopLossPercent] = useState<number>(5);
  const [takeProfitPercent, setTakeProfitPercent] = useState<number>(15);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Sync symbol when parent changes
  useEffect(() => {
    setSymbol(selectedSymbol);
  }, [selectedSymbol]);

  const runSimulation = async () => {
    setLoading(true);
    try {
      const payload: BacktestParams = {
        symbol,
        strategy,
        timeframe,
        initialCapital,
        fastPeriod: strategy === 'MA_CROSSOVER' ? fastPeriod : undefined,
        slowPeriod: strategy === 'MA_CROSSOVER' ? slowPeriod : undefined,
        rsiOversold: strategy === 'RSI_REVERSION' ? rsiOversold : undefined,
        rsiOverbought: strategy === 'RSI_REVERSION' ? rsiOverbought : undefined,
        stopLossPercent: stopLossPercent > 0 ? stopLossPercent : undefined,
        takeProfitPercent: takeProfitPercent > 0 ? takeProfitPercent : undefined,
      };

      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        setResult(data);
      }
    } catch (err) {
      console.error('Backtest run error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runSimulation();
  }, [symbol, strategy, timeframe]);

  // Equity Curve SVG dimensions
  const svgWidth = 840;
  const svgHeight = 280;
  const pad = { top: 20, right: 60, bottom: 30, left: 20 };

  const curve = result?.equityCurve || [];
  const minEquity = curve.length > 0 ? Math.min(...curve.map((p) => Math.min(p.portfolioValue, p.benchmarkValue))) * 0.95 : initialCapital;
  const maxEquity = curve.length > 0 ? Math.max(...curve.map((p) => Math.max(p.portfolioValue, p.benchmarkValue))) * 1.05 : initialCapital * 1.5;
  const equityRange = maxEquity - minEquity || 1;

  const getCurveX = (idx: number) => {
    if (curve.length <= 1) return pad.left;
    const w = svgWidth - pad.left - pad.right;
    return pad.left + (idx / (curve.length - 1)) * w;
  };

  const getCurveY = (val: number) => {
    const h = svgHeight - pad.top - pad.bottom;
    return pad.top + (1 - (val - minEquity) / equityRange) * h;
  };

  return (
    <div className="space-y-6">
      {/* Configuration Header Panel */}
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-200 pb-4 mb-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 font-sans flex items-center gap-2">
              <Zap className="h-5 w-5 text-cyan-600" /> Quantitative Strategy Backtester & Simulator
            </h2>
            <p className="text-xs text-slate-500 font-mono mt-0.5">
              Simulate algorithmic trading models with risk management against S&P 500 benchmarks
            </p>
          </div>

          <button
            onClick={runSimulation}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-700 font-medium font-mono text-xs transition disabled:opacity-50"
          >
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-white" />}
            <span>Run Backtest</span>
          </button>
        </div>

        {/* Strategy Selector & Parameters Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
          {/* Ticker & Strategy */}
          <div>
            <label className="block text-slate-500 text-[11px] uppercase mb-1">Target Stock Symbol</label>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-cyan-700 font-bold outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block text-slate-500 text-[11px] uppercase mb-1">Algorithmic Model</label>
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as any)}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-400 outline-none focus:border-cyan-500"
            >
              <option value="MA_CROSSOVER">MA Crossover (Golden/Death Cross)</option>
              <option value="RSI_REVERSION">RSI Mean Reversion (30/70)</option>
              <option value="MACD_MOMENTUM">MACD Histogram Signal</option>
              <option value="SENTIMENT_BREAKOUT">Sentiment-Augmented Trend Breakout</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-500 text-[11px] uppercase mb-1">Historical Period</label>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value as any)}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-400 outline-none focus:border-cyan-500"
            >
              <option value="6mo">6 Months</option>
              <option value="1y">1 Year</option>
              <option value="2y">2 Years</option>
              <option value="5y">5 Years</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-500 text-[11px] uppercase mb-1">Starting Capital ($)</label>
            <select
              value={initialCapital}
              onChange={(e) => setInitialCapital(Number(e.target.value))}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-400 outline-none focus:border-cyan-500"
            >
              <option value="10000">$10,000</option>
              <option value="50000">$50,000</option>
              <option value="100000">$100,000</option>
            </select>
          </div>
        </div>

        {/* Dynamic Model Rules */}
        <div className="mt-4 pt-4 border-t border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-4 font-mono text-xs">
          {strategy === 'MA_CROSSOVER' && (
            <>
              <div>
                <label className="block text-slate-500 text-[11px] uppercase mb-1">Fast MA Period</label>
                <input
                  type="number"
                  value={fastPeriod}
                  onChange={(e) => setFastPeriod(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-400"
                />
              </div>
              <div>
                <label className="block text-slate-500 text-[11px] uppercase mb-1">Slow MA Period</label>
                <input
                  type="number"
                  value={slowPeriod}
                  onChange={(e) => setSlowPeriod(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-400"
                />
              </div>
            </>
          )}

          {strategy === 'RSI_REVERSION' && (
            <>
              <div>
                <label className="block text-slate-500 text-[11px] uppercase mb-1">RSI Oversold (Buy)</label>
                <input
                  type="number"
                  value={rsiOversold}
                  onChange={(e) => setRsiOversold(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-400"
                />
              </div>
              <div>
                <label className="block text-slate-500 text-[11px] uppercase mb-1">RSI Overbought (Sell)</label>
                <input
                  type="number"
                  value={rsiOverbought}
                  onChange={(e) => setRsiOverbought(Number(e.target.value))}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-400"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-slate-500 text-[11px] uppercase mb-1">Stop Loss Limit %</label>
            <input
              type="number"
              value={stopLossPercent}
              onChange={(e) => setStopLossPercent(Number(e.target.value))}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-400"
            />
          </div>

          <div>
            <label className="block text-slate-500 text-[11px] uppercase mb-1">Take Profit Target %</label>
            <input
              type="number"
              value={takeProfitPercent}
              onChange={(e) => setTakeProfitPercent(Number(e.target.value))}
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-400"
            />
          </div>
        </div>
      </div>

      {/* KPI Performance Cards */}
      {result && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="glass-panel rounded-xl p-4 border border-slate-200">
            <div className="text-[10px] font-mono uppercase text-slate-500">Total Return</div>
            <div className={`text-xl font-extrabold font-mono mt-1 ${result.totalReturnPercent >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {result.totalReturnPercent >= 0 ? '+' : ''}{result.totalReturnPercent.toFixed(2)}%
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-0.5">
              SPY: {result.benchmarkReturnPercent >= 0 ? '+' : ''}{result.benchmarkReturnPercent.toFixed(2)}%
            </div>
          </div>

          <div className="glass-panel rounded-xl p-4 border border-slate-200">
            <div className="text-[10px] font-mono uppercase text-slate-500">Alpha vs SPY</div>
            <div className={`text-xl font-extrabold font-mono mt-1 ${result.totalReturnPercent - result.benchmarkReturnPercent >= 0 ? 'text-cyan-600' : 'text-rose-600'}`}>
              {(result.totalReturnPercent - result.benchmarkReturnPercent) >= 0 ? '+' : ''}
              {(result.totalReturnPercent - result.benchmarkReturnPercent).toFixed(2)}%
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-0.5">Strategy Excess</div>
          </div>

          <div className="glass-panel rounded-xl p-4 border border-slate-200">
            <div className="text-[10px] font-mono uppercase text-slate-500">Sharpe Ratio</div>
            <div className="text-xl font-extrabold font-mono text-slate-900 mt-1">
              {result.sharpeRatio.toFixed(2)}
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-0.5">Annualized Risk-Adj</div>
          </div>

          <div className="glass-panel rounded-xl p-4 border border-slate-200">
            <div className="text-[10px] font-mono uppercase text-slate-500">Max Drawdown</div>
            <div className="text-xl font-extrabold font-mono text-rose-600 mt-1">
              -{result.maxDrawdownPercent.toFixed(2)}%
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-0.5">Peak-to-Trough</div>
          </div>

          <div className="glass-panel rounded-xl p-4 border border-slate-200">
            <div className="text-[10px] font-mono uppercase text-slate-500">Win Rate</div>
            <div className="text-xl font-extrabold font-mono text-emerald-600 mt-1">
              {result.winRatePercent.toFixed(1)}%
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-0.5">
              {result.winningTrades}W / {result.losingTrades}L ({result.totalTrades} trades)
            </div>
          </div>

          <div className="glass-panel rounded-xl p-4 border border-slate-200">
            <div className="text-[10px] font-mono uppercase text-slate-500">Profit Factor</div>
            <div className="text-xl font-extrabold font-mono text-cyan-700 mt-1">
              {result.profitFactor.toFixed(2)}
            </div>
            <div className="text-[10px] font-mono text-slate-500 mt-0.5">Gross Win / Loss</div>
          </div>
        </div>
      )}

      {/* Equity Curve Visual Chart */}
      {result && result.equityCurve.length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-3 mb-4">
            <div>
              <h3 className="text-base font-bold text-slate-900 font-sans">Simulated Equity Curve vs Benchmark</h3>
              <p className="text-xs text-slate-500 font-mono mt-0.5">Strategy portfolio valuation tracking against SPY equity index</p>
            </div>

            <div className="flex items-center gap-4 text-xs font-mono">
              <span className="flex items-center gap-1.5 text-cyan-600">
                <span className="inline-block h-3 w-3 rounded-full bg-cyan-400" /> Model Portfolio
              </span>
              <span className="flex items-center gap-1.5 text-slate-500">
                <span className="inline-block h-3 w-3 rounded-full bg-slate-500" /> S&P 500 (SPY)
              </span>
            </div>
          </div>

          <div className="relative">
            <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto select-none font-mono">
              {/* Horizontal gridlines */}
              {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
                const val = minEquity + (1 - pct) * equityRange;
                const y = pad.top + pct * (svgHeight - pad.top - pad.bottom);
                return (
                  <g key={i}>
                    <line x1={pad.left} y1={y} x2={svgWidth - pad.right} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
                    <text x={svgWidth - pad.right + 6} y={y + 4} fill="#64748b" fontSize="10">
                      ${Math.round(val).toLocaleString()}
                    </text>
                  </g>
                );
              })}

              {/* Benchmark Line (SPY) */}
              <path
                d={curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${getCurveX(i)} ${getCurveY(p.benchmarkValue)}`).join(' ')}
                fill="none"
                stroke="#64748b"
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />

              {/* Model Portfolio Line */}
              <path
                d={curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${getCurveX(i)} ${getCurveY(p.portfolioValue)}`).join(' ')}
                fill="none"
                stroke="#0891b2"
                strokeWidth="2.5"
              />
            </svg>
          </div>
        </div>
      )}

      {/* Trades Audit Log Table */}
      {result && result.trades.length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="text-base font-bold text-slate-900 font-sans mb-3">Simulated Executed Trades Audit Log</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="pb-3 font-semibold">Trade #</th>
                  <th className="pb-3 font-semibold">Action</th>
                  <th className="pb-3 font-semibold">Date</th>
                  <th className="pb-3 font-semibold">Execution Price</th>
                  <th className="pb-3 font-semibold">Shares</th>
                  <th className="pb-3 font-semibold">Position Size</th>
                  <th className="pb-3 font-semibold">Return %</th>
                  <th className="pb-3 font-semibold">Net P&L ($)</th>
                  <th className="pb-3 font-semibold">Exit Trigger</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {result.trades.map((tr) => (
                  <tr key={tr.id} className="hover:bg-slate-50 transition">
                    <td className="py-2.5 text-slate-500">{tr.id}</td>
                    <td className="py-2.5 font-bold">
                      <span className={`px-2 py-0.5 rounded text-[10px] ${tr.type === 'BUY' ? 'bg-cyan-50 text-cyan-700' : 'bg-amber-50 text-amber-600'}`}>
                        {tr.type}
                      </span>
                    </td>
                    <td className="py-2.5 text-slate-400">{tr.date}</td>
                    <td className="py-2.5 text-slate-900">${tr.price.toFixed(2)}</td>
                    <td className="py-2.5 text-slate-400">{tr.shares}</td>
                    <td className="py-2.5 text-slate-400">${tr.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td className="py-2.5">
                      {tr.returnPercent !== undefined ? (
                        <span className={`font-bold ${tr.returnPercent >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {tr.returnPercent >= 0 ? '+' : ''}{tr.returnPercent}%
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="py-2.5">
                      {tr.pnl !== undefined ? (
                        <span className={`font-bold ${tr.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {tr.pnl >= 0 ? '+' : ''}${tr.pnl.toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="py-2.5 text-slate-500 text-[11px]">{tr.exitReason || 'ENTRY'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
