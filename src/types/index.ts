export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  peRatio?: number;
  week52High: number;
  week52Low: number;
  currency: string;
  exchange: string;
  marketState: 'PRE' | 'REGULAR' | 'POST' | 'CLOSED';
  timestamp: number;
}

export interface Candle {
  time: string; // YYYY-MM-DD or Unix timestamp string
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CompanyOverview {
  symbol: string;
  name: string;
  description: string;
  sector: string;
  industry: string;
  ceo?: string;
  website?: string;
  employees?: number;
  headquarters?: string;
  exchange: string;
  currency: string;
}

export interface KeyFinancials {
  symbol: string;
  marketCap: number;
  enterpriseValue?: number;
  trailingPE?: number;
  forwardPE?: number;
  pegRatio?: number;
  priceToSales?: number;
  priceToBook?: number;
  evToEbitda?: number;
  profitMargin?: number;
  operatingMargin?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  revenue?: number;
  revenuePerShare?: number;
  quarterlyRevenueGrowth?: number;
  grossProfit?: number;
  ebitda?: number;
  netIncome?: number;
  dilutedEPS?: number;
  totalCash?: number;
  totalDebt?: number;
  debtToEquity?: number;
  currentRatio?: number;
  freeCashflow?: number;
  operatingCashflow?: number;
  beta?: number;
  sharesOutstanding?: number;
  dividendRate?: number;
  dividendYield?: number;
  payoutRatio?: number;
  targetMeanPrice?: number;
  targetHighPrice?: number;
  targetLowPrice?: number;
  recommendationKey?: string;
  numberOfAnalystOpinions?: number;
}

export interface FinancialStatementItem {
  year: string;
  revenue: number;
  costOfRevenue: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingIncome: number;
  netIncome: number;
  ebitda: number;
  eps: number;
}

export interface NewsArticle {
  id: string;
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: number;
  thumbnailUrl?: string;
  summary?: string;
  relatedTickers?: string[];
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sentimentScore: number; // -1.0 to 1.0
  confidence: number; // 0.0 to 1.0
  catalystCategory?: 'EARNINGS' | 'PRODUCT' | 'REGULATORY' | 'MACRO' | 'M&A' | 'LEGAL' | 'ANALYST_RATING' | 'GENERAL';
  catalystSummary?: string;
}

export interface SentimentAnalysisResult {
  symbol: string;
  overallScore: number; // -100 to +100
  sentimentLabel: 'STRONGLY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONGLY_BEARISH';
  bullishPercentage: number;
  bearishPercentage: number;
  neutralPercentage: number;
  articlesAnalyzedCount: number;
  predictiveInsight: {
    bias: 'POSITIVE_CATALYST' | 'NEGATIVE_CATALYST' | 'SIDEWAYS_CONSOLIDATION';
    projectedImpactRangePercent: [number, number]; // e.g. [+1.5%, +4.2%]
    confidence: number; // 0 to 100
    topCatalysts: string[];
    riskFactors: string[];
    rationale: string;
  };
  news: NewsArticle[];
}

export interface SecFiling {
  id: string;
  type: string; // 10-K, 10-Q, 8-K, Form 4
  title: string;
  date: string;
  edgarUrl: string;
  keyPoints?: string[];
  periodEnd?: string;
}

export interface EarningsTranscriptHighlight {
  quarter: string;
  date: string;
  revenueSurprisePercent?: number;
  epsSurprisePercent?: number;
  executiveSummary: string;
  positiveHighlights: string[];
  concernsOrHeadwinds: string[];
  futureGuidance: string;
}

export interface ScreenerFilter {
  sector?: string;
  minMarketCap?: number;
  maxMarketCap?: number;
  minPE?: number;
  maxPE?: number;
  minDividendYield?: number;
  maxDividendYield?: number;
  minBeta?: number;
  maxBeta?: number;
  minRSI?: number;
  maxRSI?: number;
  minSentimentScore?: number;
  pricePerformance?: 'GAINER_TODAY' | 'LOSER_TODAY' | 'NEAR_52W_HIGH' | 'NEAR_52W_LOW' | 'ALL';
  sortBy?: 'marketCap' | 'changePercent' | 'peRatio' | 'sentimentScore' | 'volume';
  sortOrder?: 'asc' | 'desc';
  // --- EDGAR warehouse filters (new, optional; legacy fields above kept for compat) ---
  maxPe?: number;
  minRevenueGrowth?: number;
  minNetMargin?: number;
  minRoe?: number;
  searchQuery?: string;
  limit?: number;
}

export interface ScreenerStockResult {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  marketCap: number;
  peRatio?: number;
  dividendYield?: number;
  beta?: number;
  rsi14?: number;
  sentimentScore: number;
  sentimentLabel: string;
  volume: number;
  // --- EDGAR warehouse fundamentals (new, optional) ---
  revenueGrowthYoY?: number;
  netMargin?: number;
  roe?: number;
  revenue?: number;
  netIncome?: number;
  epsDiluted?: number;
  fiscalYear?: string;
  fiscalPeriod?: string;
}

export interface TechnicalIndicatorData {
  time: string;
  sma20?: number;
  sma50?: number;
  sma200?: number;
  ema9?: number;
  ema21?: number;
  rsi14?: number;
  macd?: {
    macd: number;
    signal: number;
    histogram: number;
  };
  bollinger?: {
    upper: number;
    middle: number;
    lower: number;
  };
  vwap?: number;
}

export interface TechnicalSummary {
  symbol: string;
  currentPrice: number;
  rsi14: number;
  rsiCondition: 'OVERBOUGHT' | 'NEUTRAL' | 'OVERSOLD';
  trendShortTerm: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  trendLongTerm: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  goldenCross: boolean;
  deathCross: boolean;
  macdCross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NEUTRAL';
  supportLevels: number[];
  resistanceLevels: number[];
  overallSignal: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
}

export interface BacktestParams {
  symbol: string;
  strategy: 'MA_CROSSOVER' | 'RSI_REVERSION' | 'MACD_MOMENTUM' | 'SENTIMENT_BREAKOUT';
  initialCapital: number;
  timeframe: '6mo' | '1y' | '2y' | '5y';
  fastPeriod?: number; // e.g. 50 or 9
  slowPeriod?: number; // e.g. 200 or 21
  rsiOverbought?: number; // e.g. 70
  rsiOversold?: number; // e.g. 30
  stopLossPercent?: number; // e.g. 5
  takeProfitPercent?: number; // e.g. 15
}

export interface BacktestTrade {
  id: string;
  type: 'BUY' | 'SELL';
  date: string;
  price: number;
  shares: number;
  amount: number;
  returnPercent?: number;
  pnl?: number;
  exitReason?: 'SIGNAL' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'END_OF_PERIOD';
}

export interface EquityCurvePoint {
  date: string;
  portfolioValue: number;
  benchmarkValue: number;
  drawdownPercent: number;
}

export interface BacktestResult {
  params: BacktestParams;
  totalReturnPercent: number;
  benchmarkReturnPercent: number;
  cagr: number;
  sharpeRatio: number;
  maxDrawdownPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePercent: number;
  profitFactor: number;
  averageTradeReturnPercent: number;
  equityCurve: EquityCurvePoint[];
  trades: BacktestTrade[];
}

export interface PortfolioPosition {
  symbol: string;
  name: string;
  shares: number;
  avgBuyPrice: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  weightPercent: number;
}

export interface PortfolioTransaction {
  id: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  shares: number;
  price: number;
  totalAmount: number;
  timestamp: number;
}

export interface PortfolioState {
  cashBalance: number;
  initialBalance: number;
  totalEquity: number;
  totalPnL: number;
  totalPnLPercent: number;
  positions: PortfolioPosition[];
  transactions: PortfolioTransaction[];
  watchlists: {
    id: string;
    name: string;
    symbols: string[];
  }[];
}

export interface PredictionPriceTargets {
  currentPrice: number;
  entryZone: [number, number];
  target1: { price: number; upsidePercent: number; label: string };
  target2: { price: number; upsidePercent: number; label: string };
  target3: { price: number; upsidePercent: number; label: string };
  stopLoss: { price: number; riskPercent: number; rationale: string };
  riskRewardRatio: number;
  resistances: { level: string; price: number; strength: 'MINOR' | 'MODERATE' | 'STRONG' }[];
  supports: { level: string; price: number; strength: 'MINOR' | 'MODERATE' | 'STRONG' }[];
}

export interface DimensionAnalysis {
  score: number;
  verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  summary: string;
  keyDrivers: string[];
}

export interface FinalStockPrediction {
  symbol: string;
  companyName: string;
  recommendation: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  confidenceScore: number;
  timeHorizon: string;
  synthesisRationale: string;
  priceTargets: PredictionPriceTargets;
  dimensions: {
    technicalChart: DimensionAnalysis;
    newsSentiment: DimensionAnalysis;
    fundamentalsValuation: DimensionAnalysis;
    secRegulatoryFilings: DimensionAnalysis;
  };
  invalidationTrigger: string;
  tradeExecutionSummary: string;
  generatedAt: number;
}
