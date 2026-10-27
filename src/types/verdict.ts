/**
 * AI Verdict types. Kept separate from src/types/index.ts so this module
 * can evolve independently — always import from './verdict'.
 */

export type VerdictAction = 'BUY' | 'HOLD' | 'NEUTRAL' | 'SELL';
export type VerdictHorizon = 'short' | 'swing' | 'long';
export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';

export interface VerdictNewsItem {
  title: string;
  source: string;
  url?: string;
  sentiment: NewsSentiment;
  score: number; // -1.0 .. 1.0
}

export interface VerdictFundamentals {
  revenueGrowthYoY?: number;
  netMargin?: number;
  roe?: number;
  peRatio?: number;
  source: string; // e.g. 'SEC EDGAR (FY2024)' or 'Yahoo Finance'
}

/** One scoring component's receipt — shown verbatim in the drill-down panel. */
export interface VerdictScoreComponent {
  points: number;
  detail: string;
}

export interface VerdictBreakdown {
  score: number;
  trend: VerdictScoreComponent;
  rsi: VerdictScoreComponent;
  sentiment: VerdictScoreComponent;
  fundamentals: VerdictScoreComponent & {
    max: number;
    used: boolean;
    factors: { name: string; value: string; points: number }[];
    /** Renormalized cross-sectional percentile composite (0-100) when scored on the sector-percentile basis. */
    composite?: number;
  };
  /** 12-1 momentum (skip-1m) block, ±10. Absent when history is too short. */
  momentum?: VerdictScoreComponent;
  bearishVotes?: { count: number; reasons: string[] };
}

export interface VerdictEarnings {
  earningsDate: string; // ISO
  daysUntil: number | null;
}

export interface AiVerdict {
  symbol: string;
  name: string;
  price: number;
  asOf: number;
  verdict: {
    action: VerdictAction;
    confidence: number; // 0..100
    horizon: VerdictHorizon;
    summary: string;
  };
  levels: {
    target1?: number;
    target2?: number;
    stopLoss?: number;
    supports: number[];
    resistances: number[];
    sma20?: number;
    sma50?: number;
    sma200?: number;
    rsi14?: number;
    atr14?: number;
    week52High?: number;
    week52Low?: number;
  };
  drivers: {
    bullish: string[];
    bearish: string[];
    newsItems: VerdictNewsItem[];
  };
  strategy: {
    headline: string;
    entry?: string;
    plan: string[];
    riskNote: string;
  };
  fundamentals?: VerdictFundamentals;
  /** Per-component score receipts (drill-down "show the receipts" panel). */
  breakdown?: VerdictBreakdown;
  /** Next earnings date when known (svc-research earnings-calendar). */
  earnings?: VerdictEarnings | null;
  technicals: {
    trend: 'up' | 'down' | 'sideways';
    rsi14?: number;
    sentimentScore?: number;
  };
  aiNarrative?: string;
  disclaimer: string;
}
