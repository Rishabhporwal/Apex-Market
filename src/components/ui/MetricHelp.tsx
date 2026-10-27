'use client';

import React from 'react';
import { HelpCircle } from 'lucide-react';

/**
 * Plain-English explanations for every metric on the platform.
 * Written so a non-technical user understands instantly.
 */
export const METRIC_HELP: Record<string, string> = {
  price: 'What one share costs to buy right now.',
  changePercent: 'How much the price moved today, as a percent.',
  marketCap: 'The total value of the whole company (price × all shares). Bigger = more established.',
  peRatio:
    'How much you pay for each $1 of yearly profit. Lower usually means cheaper — but fast-growing companies can deserve a higher number. Above ~40 often means investors expect big growth.',
  revenueGrowthYoY: 'How fast the company’s sales grew over the last year, compared to the year before.',
  netMargin: 'Of every $100 the company earns in sales, how many dollars end up as profit after all costs.',
  roe: 'How effectively the company turns investors’ money into profit. Above ~15% is considered strong.',
  dividendYield: 'Cash the company pays you each year, as a percent of the share price. Like interest on savings.',
  volume: 'How many shares changed hands today.',
  rsi14: 'A “speedometer” for the price. Below 30 suggests the stock may be oversold; above 70 may be overheated.',
  sentimentScore: 'Our AI’s read of recent news and social chatter about this company, from -100 (very negative) to +100 (very positive).',
  eps: 'The company’s yearly profit divided by every share. Your slice of the profit.',
  fiscalYear: 'The company’s most recent complete business year reported to the SEC.',
  source: 'Where the number comes from. SEC filings = official company reports. Yahoo = live market prices.',
};

export function MetricHelp({
  term,
  className = '',
}: {
  term: keyof typeof METRIC_HELP | string;
  className?: string;
}) {
  const text = METRIC_HELP[term as string];
  if (!text) return null;
  return (
    <span className={`relative inline-flex group/help align-middle ${className}`} title={text}>
      <HelpCircle className="h-3.5 w-3.5 text-muted hover:text-accent cursor-help transition" />
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover/help:block z-50 w-60 rounded-lg bg-slate-50 border border-slate-300 p-2.5 text-xs leading-relaxed text-muted font-sans shadow-md">
        {text}
      </span>
    </span>
  );
}

/** Short friendly verdict line for a stock, computed from its fundamentals. */
export function plainEnglishSummary(s: {
  revenueGrowthYoY?: number | null;
  netMargin?: number | null;
  roe?: number | null;
  peRatio?: number | null;
  dividendYield?: number | null;
  marketCap?: number | null;
}): string {
  const bits: string[] = [];
  const g = s.revenueGrowthYoY ?? null;
  const m = s.netMargin ?? null;
  if (g != null) {
    if (g >= 20) bits.push('sales are growing fast');
    else if (g >= 5) bits.push('sales are growing steadily');
    else if (g >= 0) bits.push('sales are roughly flat');
    else bits.push('sales are shrinking');
  }
  if (m != null) {
    if (m >= 20) bits.push('very profitable');
    else if (m >= 8) bits.push('solidly profitable');
    else if (m >= 0) bits.push('thinly profitable');
    else bits.push('currently losing money');
  }
  if (s.peRatio != null && s.peRatio > 0) {
    if (s.peRatio < 15) bits.push('trades cheaply');
    else if (s.peRatio > 45) bits.push('priced for big growth');
  }
  if ((s.dividendYield ?? 0) >= 2) bits.push(`pays a ${(s.dividendYield as number).toFixed(1)}% dividend`);
  if (!bits.length) return 'Fundamentals from SEC filings.';
  const cap = s.marketCap
    ? s.marketCap >= 200e9
      ? 'giant'
      : s.marketCap >= 10e9
        ? 'large'
        : 'smaller'
    : null;
  return `${cap ? `A ${cap} company where ` : 'A company where '}${bits.join(', ')}.`;
}
