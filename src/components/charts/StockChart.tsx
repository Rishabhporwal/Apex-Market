'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  BarChart, 
  TrendingUp, 
  Sliders, 
  Maximize2, 
  RefreshCw, 
  Calendar,
  Layers,
  Activity,
  ArrowUp,
  ArrowDown
} from 'lucide-react';
import { Candle, StockQuote, TechnicalSummary, TechnicalIndicatorData } from '@/types';

interface StockChartProps {
  symbol: string;
  quote?: StockQuote | null;
  onRefresh?: () => void;
}

export function StockChart({ symbol, quote, onRefresh }: StockChartProps) {
  const [timeframe, setTimeframe] = useState<'1d' | '5d' | '1mo' | '6mo' | '1y' | '5y'>('1y');
  const [chartType, setChartType] = useState<'candles' | 'line'>('candles');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [technicalSummary, setTechnicalSummary] = useState<TechnicalSummary | null>(null);
  const [indicatorData, setIndicatorData] = useState<TechnicalIndicatorData[]>([]);
  const [loading, setLoading] = useState(true);

  // Overlay toggles
  const [showSMA20, setShowSMA20] = useState(true);
  const [showSMA50, setShowSMA50] = useState(true);
  const [showBollinger, setShowBollinger] = useState(false);
  const [subIndicator, setSubIndicator] = useState<'volume' | 'rsi' | 'macd'>('volume');

  // Hover state
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Canvas / SVG refs
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch candles & technical indicators
  useEffect(() => {
    let isMounted = true;
    async function loadChartData() {
      setLoading(true);
      try {
        const [candleRes, techRes] = await Promise.all([
          fetch(`/api/market-data?type=candles&symbol=${symbol}&timeframe=${timeframe}`),
          fetch(`/api/technical?symbol=${symbol}&timeframe=${timeframe}`),
        ]);

        if (candleRes.ok && isMounted) {
          const cData = await candleRes.json();
          // Gateway shape is {symbol, count, candles: [...]}; tolerate a bare
          // array too (local fallback shape).
          setCandles(Array.isArray(cData) ? cData : cData.candles || []);
        }

        if (techRes.ok && isMounted) {
          const tData = await techRes.json();
          setTechnicalSummary(tData.summary);
          setIndicatorData(tData.indicatorSeries || []);
        }
      } catch (err) {
        console.error('Failed to load chart data:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadChartData();
    return () => {
      isMounted = false;
    };
  }, [symbol, timeframe]);

  const activeCandle = hoverIndex !== null && candles[hoverIndex] ? candles[hoverIndex] : candles[candles.length - 1];

  // SVG dimensions
  const chartHeight = 360;
  const subChartHeight = 110;
  const svgWidth = 860;
  const padding = { top: 20, right: 65, bottom: 25, left: 10 };

  // Price calculations
  const minPrice = candles.length > 0 ? Math.min(...candles.map((c) => c.low)) * 0.985 : 0;
  const maxPrice = candles.length > 0 ? Math.max(...candles.map((c) => c.high)) * 1.015 : 100;
  const priceRange = maxPrice - minPrice || 1;

  const maxVolume = candles.length > 0 ? Math.max(...candles.map((c) => c.volume)) || 1 : 1;

  // Scale coordinates
  const getX = (index: number) => {
    if (candles.length <= 1) return padding.left;
    const usableWidth = svgWidth - padding.left - padding.right;
    return padding.left + (index / (candles.length - 1)) * usableWidth;
  };

  const getY = (price: number) => {
    const usableHeight = chartHeight - padding.top - padding.bottom;
    return padding.top + (1 - (price - minPrice) / priceRange) * usableHeight;
  };

  // Signal color helpers
  const getSignalBadgeColor = (signal?: string) => {
    switch (signal) {
      case 'STRONG_BUY':
        return 'bg-emerald-50 text-emerald-600 border-emerald-200';
      case 'BUY':
        return 'bg-emerald-50 text-emerald-600 border-emerald-200';
      case 'STRONG_SELL':
        return 'bg-rose-50 text-rose-600 border-rose-200';
      case 'SELL':
        return 'bg-rose-50 text-rose-600 border-rose-200';
      default:
        return 'bg-amber-50 text-amber-600 border-amber-200';
    }
  };

  return (
    <div className="space-y-4">
      {/* Stock Quote Header Bar */}
      <div className="glass-panel rounded-2xl p-4 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-50 border border-slate-300 font-mono font-bold text-lg text-cyan-600">
            {symbol.slice(0, 3)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono tracking-tight text-slate-900">{symbol}</h1>
              <span className="text-sm text-muted font-sans">{quote?.name || 'Equity Corporation'}</span>
              <span className="rounded bg-slate-50 px-2 py-0.5 text-xs font-mono text-muted border border-slate-300">
                {quote?.exchange || 'NASDAQ'}
              </span>
            </div>
            <div className="flex items-baseline gap-3 mt-1">
              <span className="text-3xl font-extrabold font-mono text-slate-900 tracking-tight">
                ${quote?.price ? quote.price.toFixed(2) : (activeCandle?.close || 0).toFixed(2)}
              </span>
              {quote && (
                <span
                  className={`flex items-center text-sm font-semibold font-mono px-2 py-0.5 rounded ${
                    quote.change >= 0
                      ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                      : 'bg-rose-50 text-rose-600 border border-rose-200'
                  }`}
                >
                  {quote.change >= 0 ? <ArrowUp className="h-3.5 w-3.5 mr-0.5" /> : <ArrowDown className="h-3.5 w-3.5 mr-0.5" />}
                  {quote.change >= 0 ? '+' : ''}
                  {quote.change.toFixed(2)} ({quote.changePercent.toFixed(2)}%)
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Technical Signal Summary Card */}
        {technicalSummary && (
          <div className="flex items-center gap-4 border-l border-slate-200 pl-4 sm:pl-6">
            <div>
              <div className="text-xs uppercase font-semibold text-muted tracking-wider">Quant Signal</div>
              <div
                className={`mt-1 inline-flex items-center px-3 py-1 rounded-full text-xs font-mono font-bold border ${getSignalBadgeColor(
                  technicalSummary.overallSignal
                )}`}
              >
                {technicalSummary.overallSignal.replace('_', ' ')}
              </div>
            </div>

            <div>
              <div className="text-xs uppercase font-semibold text-muted tracking-wider">RSI (14)</div>
              <div className="mt-1 flex items-center gap-1.5 font-mono text-xs">
                <span className="font-bold text-slate-900">{technicalSummary.rsi14.toFixed(1)}</span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    technicalSummary.rsiCondition === 'OVERBOUGHT'
                      ? 'bg-rose-50 text-rose-600'
                      : technicalSummary.rsiCondition === 'OVERSOLD'
                      ? 'bg-emerald-50 text-emerald-600'
                      : 'bg-slate-50 text-muted'
                  }`}
                >
                  {technicalSummary.rsiCondition}
                </span>
              </div>
            </div>

            <div className="hidden md:block">
              <div className="text-xs uppercase font-semibold text-muted tracking-wider">Trend Setup</div>
              <div className="mt-1 flex gap-1 font-mono text-xs">
                <span className={`px-1.5 py-0.5 rounded ${technicalSummary.trendShortTerm === 'BULLISH' ? 'text-emerald-600 bg-emerald-50' : 'text-muted bg-slate-50'}`}>
                  Short: {technicalSummary.trendShortTerm}
                </span>
                <span className={`px-1.5 py-0.5 rounded ${technicalSummary.trendLongTerm === 'BULLISH' ? 'text-emerald-600 bg-emerald-50' : 'text-muted bg-slate-50'}`}>
                  Long: {technicalSummary.trendLongTerm}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Interactive Chart Container */}
      <div className="glass-panel rounded-2xl p-4 sm:p-6" ref={containerRef}>
        {/* Controls Bar: Timeframe, Chart Type, Indicator Toggles */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 mb-4">
          {/* Timeframe Selectors */}
          <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200 font-mono text-xs">
            {(['1d', '5d', '1mo', '6mo', '1y', '5y'] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  timeframe === tf
                    ? 'bg-accent text-white font-bold'
                    : 'text-muted hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Chart Style & Overlays */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Chart Type Toggle */}
            <div className="flex items-center bg-white p-1 rounded-xl border border-slate-200">
              <button
                onClick={() => setChartType('candles')}
                className={`px-2.5 py-1 rounded-lg transition ${chartType === 'candles' ? 'bg-slate-50 text-cyan-600 font-bold' : 'text-muted'}`}
              >
                Candles
              </button>
              <button
                onClick={() => setChartType('line')}
                className={`px-2.5 py-1 rounded-lg transition ${chartType === 'line' ? 'bg-slate-50 text-cyan-600 font-bold' : 'text-muted'}`}
              >
                Area Line
              </button>
            </div>

            {/* Overlays */}
            <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200 font-mono">
              <button
                onClick={() => setShowSMA20(!showSMA20)}
                className={`px-2 py-1 rounded transition text-xs ${showSMA20 ? 'bg-amber-50 text-amber-600 font-semibold border border-amber-200' : 'text-muted'}`}
              >
                SMA 20
              </button>
              <button
                onClick={() => setShowSMA50(!showSMA50)}
                className={`px-2 py-1 rounded transition text-xs ${showSMA50 ? 'bg-blue-50 text-blue-600 font-semibold border border-blue-200' : 'text-muted'}`}
              >
                SMA 50
              </button>
              <button
                onClick={() => setShowBollinger(!showBollinger)}
                className={`px-2 py-1 rounded transition text-xs ${showBollinger ? 'bg-purple-50 text-purple-600 font-semibold border border-purple-200' : 'text-muted'}`}
              >
                BBands
              </button>
            </div>

            {/* Sub-Indicator Switcher */}
            <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200 font-mono">
              {(['volume', 'rsi', 'macd'] as const).map((ind) => (
                <button
                  key={ind}
                  onClick={() => setSubIndicator(ind)}
                  className={`px-2.5 py-1 rounded-lg uppercase text-xs transition ${
                    subIndicator === ind
                      ? 'bg-slate-50 text-cyan-600 font-bold border border-slate-300'
                      : 'text-muted hover:text-muted'
                  }`}
                >
                  {ind}
                </button>
              ))}
            </div>

            {onRefresh && (
              <button
                onClick={onRefresh}
                className="p-1.5 rounded-xl bg-white border border-slate-200 text-muted hover:text-slate-900 transition"
                title="Refresh Market Data"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* OHLCV Live Tooltip Bar */}
        {activeCandle && (
          <div className="flex flex-wrap items-center gap-4 bg-slate-50 px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono mb-2">
            <span className="text-muted">
              Date: <strong className="text-muted">{activeCandle.time}</strong>
            </span>
            <span className="text-muted">
              O: <strong className="text-muted">${activeCandle.open.toFixed(2)}</strong>
            </span>
            <span className="text-muted">
              H: <strong className="text-emerald-600">${activeCandle.high.toFixed(2)}</strong>
            </span>
            <span className="text-muted">
              L: <strong className="text-rose-600">${activeCandle.low.toFixed(2)}</strong>
            </span>
            <span className="text-muted">
              C: <strong className="text-slate-900">${activeCandle.close.toFixed(2)}</strong>
            </span>
            <span className="text-muted">
              Vol: <strong className="text-muted">{(activeCandle.volume / 1e6).toFixed(2)}M</strong>
            </span>
          </div>
        )}

        {/* Main Price Chart Render */}
        {loading ? (
          <div className="h-[460px] flex items-center justify-center text-muted font-mono">
            <RefreshCw className="h-6 w-6 animate-spin mr-2 text-cyan-600" />
            Loading high-resolution market data...
          </div>
        ) : candles.length === 0 ? (
          <div className="h-[460px] flex items-center justify-center text-muted font-mono">
            No chart data available for this timeframe.
          </div>
        ) : (
          <div className="relative">
            <svg
              viewBox={`0 0 ${svgWidth} ${chartHeight + subChartHeight}`}
              className="w-full h-auto select-none"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const mouseX = ((e.clientX - rect.left) / rect.width) * svgWidth;
                const usableWidth = svgWidth - padding.left - padding.right;
                const ratio = Math.max(0, Math.min(1, (mouseX - padding.left) / usableWidth));
                const index = Math.round(ratio * (candles.length - 1));
                setHoverIndex(index);
              }}
              onMouseLeave={() => setHoverIndex(null)}
            >
              {/* Horizontal Grid Lines & Price Labels */}
              {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
                const p = minPrice + (1 - pct) * priceRange;
                const y = padding.top + pct * (chartHeight - padding.top - padding.bottom);
                return (
                  <g key={i}>
                    <line x1={padding.left} y1={y} x2={svgWidth - padding.right} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
                    <text x={svgWidth - padding.right + 8} y={y + 4} fill="#64748b" fontSize="10" fontFamily="monospace">
                      ${p.toFixed(2)}
                    </text>
                  </g>
                );
              })}

              {/* Bollinger Bands Fill */}
              {showBollinger && (
                <path
                  d={candles
                    .map((_, i) => {
                      const bb = indicatorData[i]?.bollinger;
                      if (!bb) return null;
                      const x = getX(i);
                      const yUpper = getY(bb.upper);
                      return `${i === 0 ? 'M' : 'L'} ${x} ${yUpper}`;
                    })
                    .filter(Boolean)
                    .join(' ') +
                    ' ' +
                    candles
                      .slice()
                      .reverse()
                      .map((_, revIdx) => {
                        const i = candles.length - 1 - revIdx;
                        const bb = indicatorData[i]?.bollinger;
                        if (!bb) return null;
                        const x = getX(i);
                        const yLower = getY(bb.lower);
                        return `L ${x} ${yLower}`;
                      })
                      .filter(Boolean)
                      .join(' ') +
                    ' Z'}
                  fill="rgba(168, 85, 247, 0.08)"
                  stroke="rgba(168, 85, 247, 0.3)"
                />
              )}

              {/* Area Line Chart or Candlesticks */}
              {chartType === 'line' ? (
                <>
                  <defs>
                    <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  {/* Area fill */}
                  <path
                    d={
                      candles.map((c, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(c.close)}`).join(' ') +
                      ` L ${getX(candles.length - 1)} ${chartHeight - padding.bottom} L ${getX(0)} ${chartHeight - padding.bottom} Z`
                    }
                    fill="url(#chartGradient)"
                  />
                  {/* Line stroke */}
                  <path
                    d={candles.map((c, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(c.close)}`).join(' ')}
                    fill="none"
                    stroke="#0891b2"
                    strokeWidth="2"
                  />
                </>
              ) : (
                /* Candlesticks */
                candles.map((c, i) => {
                  const x = getX(i);
                  const isUp = c.close >= c.open;
                  const candleWidth = Math.max(1.8, Math.min(8, (svgWidth - padding.left - padding.right) / candles.length - 1.5));
                  const yHigh = getY(c.high);
                  const yLow = getY(c.low);
                  const yOpen = getY(c.open);
                  const yClose = getY(c.close);
                  const yBodyTop = Math.min(yOpen, yClose);
                  const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
                  const color = isUp ? '#10b981' : '#f43f5e';

                  return (
                    <g key={i}>
                      {/* Wick */}
                      <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth="1" />
                      {/* Body */}
                      <rect
                        x={x - candleWidth / 2}
                        y={yBodyTop}
                        width={candleWidth}
                        height={bodyHeight}
                        fill={color}
                        rx="0.5"
                      />
                    </g>
                  );
                })
              )}

              {/* Overlays: SMA 20 */}
              {showSMA20 && (
                <path
                  d={candles
                    .map((_, i) => {
                      const val = indicatorData[i]?.sma20;
                      if (!val) return null;
                      return `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(val)}`;
                    })
                    .filter(Boolean)
                    .join(' ')}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="1.5"
                />
              )}

              {/* Overlays: SMA 50 */}
              {showSMA50 && (
                <path
                  d={candles
                    .map((_, i) => {
                      const val = indicatorData[i]?.sma50;
                      if (!val) return null;
                      return `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(val)}`;
                    })
                    .filter(Boolean)
                    .join(' ')}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                />
              )}

              {/* Hover Crosshair */}
              {hoverIndex !== null && (
                <g>
                  <line
                    x1={getX(hoverIndex)}
                    y1={padding.top}
                    x2={getX(hoverIndex)}
                    y2={chartHeight + subChartHeight - 10}
                    stroke="#94a3b8"
                    strokeDasharray="2 2"
                    strokeWidth="1"
                  />
                  <line
                    x1={padding.left}
                    y1={getY(candles[hoverIndex].close)}
                    x2={svgWidth - padding.right}
                    y2={getY(candles[hoverIndex].close)}
                    stroke="#94a3b8"
                    strokeDasharray="2 2"
                    strokeWidth="1"
                  />
                  {/* Point */}
                  <circle cx={getX(hoverIndex)} cy={getY(candles[hoverIndex].close)} r="3" fill="#0891b2" />
                </g>
              )}

              {/* Divider for Sub-chart */}
              <line
                x1={padding.left}
                y1={chartHeight}
                x2={svgWidth - padding.right}
                y2={chartHeight}
                stroke="#cbd5e1"
                strokeWidth="1"
              />

              {/* Sub-chart: Volume / RSI / MACD */}
              {subIndicator === 'volume' && (
                <g transform={`translate(0, ${chartHeight + 10})`}>
                  <text x={padding.left} y="12" fill="#64748b" fontSize="10" fontFamily="monospace">
                    VOLUME (SHARES)
                  </text>
                  {candles.map((c, i) => {
                    const x = getX(i);
                    const vHeight = (c.volume / maxVolume) * (subChartHeight - 25);
                    const isUp = c.close >= c.open;
                    const w = Math.max(1.5, Math.min(8, (svgWidth - padding.left - padding.right) / candles.length - 1.5));
                    return (
                      <rect
                        key={i}
                        x={x - w / 2}
                        y={subChartHeight - 25 - vHeight}
                        width={w}
                        height={vHeight}
                        fill={isUp ? 'rgba(16, 185, 129, 0.45)' : 'rgba(244, 63, 94, 0.45)'}
                      />
                    );
                  })}
                </g>
              )}

              {subIndicator === 'rsi' && (
                <g transform={`translate(0, ${chartHeight + 10})`}>
                  <text x={padding.left} y="12" fill="#64748b" fontSize="10" fontFamily="monospace">
                    RSI 14 (30 OVERSOLD / 70 OVERBOUGHT)
                  </text>
                  {/* Reference bounds 70 & 30 */}
                  <line x1={padding.left} y1={subChartHeight * 0.3} x2={svgWidth - padding.right} y2={subChartHeight * 0.3} stroke="#f43f5e" strokeDasharray="2 2" strokeOpacity="0.5" />
                  <line x1={padding.left} y1={subChartHeight * 0.7} x2={svgWidth - padding.right} y2={subChartHeight * 0.7} stroke="#10b981" strokeDasharray="2 2" strokeOpacity="0.5" />
                  {/* RSI Curve */}
                  <path
                    d={candles
                      .map((_, i) => {
                        const r = indicatorData[i]?.rsi14;
                        if (r === undefined) return null;
                        const x = getX(i);
                        const y = subChartHeight - 20 - (r / 100) * (subChartHeight - 35);
                        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
                      })
                      .filter(Boolean)
                      .join(' ')}
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth="1.5"
                  />
                </g>
              )}

              {subIndicator === 'macd' && (
                <g transform={`translate(0, ${chartHeight + 10})`}>
                  <text x={padding.left} y="12" fill="#64748b" fontSize="10" fontFamily="monospace">
                    MACD (12, 26, 9) HISTOGRAM
                  </text>
                  <line x1={padding.left} y1={subChartHeight / 2} x2={svgWidth - padding.right} y2={subChartHeight / 2} stroke="#cbd5e1" strokeWidth="1" />
                  {candles.map((_, i) => {
                    const m = indicatorData[i]?.macd;
                    if (!m) return null;
                    const x = getX(i);
                    const zeroY = subChartHeight / 2;
                    const h = Math.min(35, Math.abs(m.histogram * 8));
                    const y = m.histogram >= 0 ? zeroY - h : zeroY;
                    const color = m.histogram >= 0 ? '#10b981' : '#f43f5e';
                    const w = Math.max(1.5, Math.min(6, (svgWidth - padding.left - padding.right) / candles.length - 1.5));
                    return <rect key={i} x={x - w / 2} y={y} width={w} height={h} fill={color} />;
                  })}
                </g>
              )}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
