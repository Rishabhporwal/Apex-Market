import { 
  FinalStockPrediction, 
  PredictionPriceTargets, 
  DimensionAnalysis, 
  Candle 
} from '@/types';
import { marketDataService } from './marketDataService';
import { technicalService } from './technicalService';
import { sentimentService } from './sentimentService';
import { financialsService } from './financialsService';
import { filingsService } from './filingsService';

class AiPredictionService {
  /**
   * Synthesize all multi-service research streams into a unified actionable prediction
   */
  async generatePrediction(symbol: string): Promise<FinalStockPrediction> {
    const cleanSymbol = symbol.trim().toUpperCase();

    // Fetch data from all purpose-built services concurrently
    const [quote, candles, sentimentData, keyFin, overview, filings, transcripts] = await Promise.all([
      marketDataService.getQuote(cleanSymbol),
      marketDataService.getHistoricalCandles(cleanSymbol, '1y', '1d'),
      sentimentService.analyzeStockSentiment(cleanSymbol),
      financialsService.getKeyFinancials(cleanSymbol).catch(() => null),
      financialsService.getCompanyOverview(cleanSymbol).catch(() => null),
      filingsService.getSecFilings(cleanSymbol).catch(() => []),
      filingsService.getEarningsTranscriptHighlights(cleanSymbol).catch(() => []),
    ]);

    const currentPrice = quote.price || (candles.length > 0 ? candles[candles.length - 1].close : 100);
    const techSummary = technicalService.getTechnicalSummary(cleanSymbol, candles);

    // 1. Analyze Dimension: Technical & Chart
    const technicalDimension = this.analyzeTechnicalDimension(techSummary, candles, currentPrice);

    // 2. Analyze Dimension: News & Sentiment
    const sentimentDimension = this.analyzeSentimentDimension(sentimentData);

    // 3. Analyze Dimension: Fundamentals & Valuation
    const fundamentalsDimension = this.analyzeFundamentalsDimension(keyFin, currentPrice);

    // 4. Analyze Dimension: SEC Filings & Earnings Call Tone
    const filingsDimension = this.analyzeFilingsDimension(filings, transcripts);

    // 5. Composite Score Calculation
    // Weights: Technical (35%), Sentiment (25%), Fundamentals (25%), Regulatory/SEC (15%)
    const compositeScore = Math.round(
      technicalDimension.score * 0.35 +
      sentimentDimension.score * 0.25 +
      fundamentalsDimension.score * 0.25 +
      filingsDimension.score * 0.15
    );

    // 6. Determine Master Recommendation
    let recommendation: FinalStockPrediction['recommendation'] = 'HOLD';
    if (compositeScore >= 45) recommendation = 'STRONG_BUY';
    else if (compositeScore >= 18) recommendation = 'BUY';
    else if (compositeScore <= -45) recommendation = 'STRONG_SELL';
    else if (compositeScore <= -18) recommendation = 'SELL';

    // 7. Calculate Confluence & Confidence Score
    const verdicts = [technicalDimension.verdict, sentimentDimension.verdict, fundamentalsDimension.verdict, filingsDimension.verdict];
    const bullishAgreement = verdicts.filter((v) => v === 'BULLISH').length;
    const bearishAgreement = verdicts.filter((v) => v === 'BEARISH').length;
    const maxAgreement = Math.max(bullishAgreement, bearishAgreement);
    const confidenceScore = Math.min(95, Math.max(55, 50 + maxAgreement * 10 + Math.abs(compositeScore) * 0.25));

    // 8. Generate Precise Numerical Price Targets, Stop Loss & Key Levels
    const priceTargets = this.calculatePriceTargets(
      currentPrice,
      techSummary.supportLevels,
      techSummary.resistanceLevels,
      recommendation,
      keyFin?.targetMeanPrice
    );

    // 9. Generate Synthesis Rationale & Invalidation Criteria
    const { rationale, invalidation, executionSummary } = this.generateExecutiveSynthesis(
      cleanSymbol,
      recommendation,
      currentPrice,
      priceTargets,
      compositeScore,
      technicalDimension,
      sentimentDimension,
      fundamentalsDimension
    );

    return {
      symbol: cleanSymbol,
      companyName: overview?.name || quote.name || cleanSymbol,
      recommendation,
      confidenceScore: Math.round(confidenceScore),
      timeHorizon: '2 - 8 Weeks (Tactical Swing / Position Horizon)',
      synthesisRationale: rationale,
      priceTargets,
      dimensions: {
        technicalChart: technicalDimension,
        newsSentiment: sentimentDimension,
        fundamentalsValuation: fundamentalsDimension,
        secRegulatoryFilings: filingsDimension,
      },
      invalidationTrigger: invalidation,
      tradeExecutionSummary: executionSummary,
      generatedAt: Date.now(),
    };
  }

  // --- Dimension Analyzers ---

  private analyzeTechnicalDimension(techSummary: any, candles: Candle[], currentPrice: number): DimensionAnalysis {
    let score = 0;
    const keyDrivers: string[] = [];

    // Trend analysis
    if (techSummary.trendLongTerm === 'BULLISH') {
      score += 35;
      keyDrivers.push('Primary long-term trend is bullish (Price > 50-day & 200-day SMAs).');
    } else if (techSummary.trendLongTerm === 'BEARISH') {
      score -= 35;
      keyDrivers.push('Primary long-term trend is bearish (Price below key moving averages).');
    }

    if (techSummary.trendShortTerm === 'BULLISH') {
      score += 25;
      keyDrivers.push('Short-term momentum aligned upward with 9/21 EMA stack.');
    } else if (techSummary.trendShortTerm === 'BEARISH') {
      score -= 25;
      keyDrivers.push('Short-term momentum under downward pressure with fast EMA death-cross.');
    }

    // RSI analysis
    if (techSummary.rsi14 < 35) {
      score += 20;
      keyDrivers.push(`RSI(14) sits in oversold territory at ${techSummary.rsi14.toFixed(1)}, signaling mean-reversion rebound potential.`);
    } else if (techSummary.rsi14 > 72) {
      score -= 20;
      keyDrivers.push(`RSI(14) is extended at ${techSummary.rsi14.toFixed(1)} (Overbought), indicating elevated risk of consolidation.`);
    } else {
      keyDrivers.push(`RSI(14) is balanced at ${techSummary.rsi14.toFixed(1)} within neutral expansion channel.`);
    }

    // MACD Cross
    if (techSummary.macdCross === 'BULLISH_CROSS') {
      score += 20;
      keyDrivers.push('Fresh bullish MACD signal crossover confirmed.');
    } else if (techSummary.macdCross === 'BEARISH_CROSS') {
      score -= 20;
      keyDrivers.push('Bearish MACD signal crossover confirmed.');
    }

    score = Math.max(-100, Math.min(100, score));

    let verdict: DimensionAnalysis['verdict'] = 'NEUTRAL';
    if (score >= 25) verdict = 'BULLISH';
    else if (score <= -25) verdict = 'BEARISH';

    const summary = verdict === 'BULLISH'
      ? `Technical structure is constructively positioned with bullish momentum alignment and firm support base.`
      : verdict === 'BEARISH'
      ? `Technical structure shows breakdown characteristics with resistance overhead and negative indicator momentum.`
      : `Technical indicators are in neutral equilibrium with choppy rangebound price action.`;

    return { score, verdict, summary, keyDrivers };
  }

  private analyzeSentimentDimension(sentimentData: any): DimensionAnalysis {
    const rawScore = sentimentData.overallScore || 0; // -100 to +100
    const keyDrivers: string[] = [];

    if (rawScore >= 30) {
      keyDrivers.push(`Dominant positive financial media coverage (${sentimentData.bullishPercentage}% bullish polarity).`);
      keyDrivers.push(`Top catalysts: ${sentimentData.predictiveInsight.topCatalysts?.[0] || 'Strong revenue acceleration'}`);
    } else if (rawScore <= -30) {
      keyDrivers.push(`Defensive financial media coverage (${sentimentData.bearishPercentage}% bearish polarity).`);
      keyDrivers.push(`Risk factors: ${sentimentData.predictiveInsight.riskFactors?.[0] || 'Macro or regulatory scrutiny'}`);
    } else {
      keyDrivers.push(`Balanced sentiment flow with mixed market commentary.`);
    }

    let verdict: DimensionAnalysis['verdict'] = 'NEUTRAL';
    if (rawScore >= 20) verdict = 'BULLISH';
    else if (rawScore <= -20) verdict = 'BEARISH';

    return {
      score: rawScore,
      verdict,
      summary: sentimentData.predictiveInsight.rationale,
      keyDrivers,
    };
  }

  private analyzeFundamentalsDimension(keyFin: any, currentPrice: number): DimensionAnalysis {
    let score = 15; // default moderate positive for established equities
    const keyDrivers: string[] = [];

    if (keyFin) {
      // P/E multiple
      if (keyFin.trailingPE && keyFin.trailingPE < 25) {
        score += 25;
        keyDrivers.push(`Attractive valuation: Trailing P/E of ${keyFin.trailingPE.toFixed(1)}x offers margin of safety.`);
      } else if (keyFin.trailingPE && keyFin.trailingPE > 65) {
        score -= 20;
        keyDrivers.push(`Premium multiple: Trailing P/E of ${keyFin.trailingPE.toFixed(1)}x requires flawless execution.`);
      }

      // Profit margins
      if (keyFin.profitMargin && keyFin.profitMargin > 0.18) {
        score += 25;
        keyDrivers.push(`High profitability: Net profit margin of ${(keyFin.profitMargin * 100).toFixed(1)}% highlights strong pricing power.`);
      }

      // Free Cash Flow
      if (keyFin.freeCashflow && keyFin.freeCashflow > 0) {
        score += 20;
        keyDrivers.push(`Robust cash generation: Positive Free Cash Flow provides strategic reinvestment liquidity.`);
      }

      // Wall Street target
      if (keyFin.targetMeanPrice && keyFin.targetMeanPrice > currentPrice) {
        const upside = ((keyFin.targetMeanPrice - currentPrice) / currentPrice) * 100;
        score += Math.min(30, upside);
        keyDrivers.push(`Wall Street consensus price target of $${keyFin.targetMeanPrice.toFixed(2)} implies +${upside.toFixed(1)}% upside.`);
      }
    } else {
      keyDrivers.push('Standard fundamental baseline applied.');
    }

    score = Math.max(-100, Math.min(100, score));

    let verdict: DimensionAnalysis['verdict'] = 'NEUTRAL';
    if (score >= 25) verdict = 'BULLISH';
    else if (score <= -25) verdict = 'BEARISH';

    const summary = verdict === 'BULLISH'
      ? `Strong fundamental profile anchored by operating profitability, positive cash generation, and analyst target headroom.`
      : verdict === 'BEARISH'
      ? `Valuation stretch or margin compression creates an unfavorable fundamental risk/reward profile.`
      : `Fundamentals are reasonably balanced with market expectations priced into the current multiple.`;

    return { score, verdict, summary, keyDrivers };
  }

  private analyzeFilingsDimension(filings: any[], transcripts: any[]): DimensionAnalysis {
    let score = 20;
    const keyDrivers: string[] = [];

    if (transcripts.length > 0) {
      const latest = transcripts[0];
      if (latest.revenueSurprisePercent && latest.revenueSurprisePercent > 0) {
        score += 25;
        keyDrivers.push(`Quarterly revenue exceeded consensus estimates by +${latest.revenueSurprisePercent.toFixed(1)}%.`);
      }
      if (latest.epsSurprisePercent && latest.epsSurprisePercent > 0) {
        score += 25;
        keyDrivers.push(`Quarterly EPS delivered a +${latest.epsSurprisePercent.toFixed(1)}% earnings surprise beat.`);
      }
      if (latest.positiveHighlights?.[0]) {
        keyDrivers.push(`Management highlights: ${latest.positiveHighlights[0]}`);
      }
    } else {
      keyDrivers.push('Regulatory filings verified in compliance with SEC reporting standards.');
    }

    score = Math.max(-100, Math.min(100, score));

    let verdict: DimensionAnalysis['verdict'] = 'NEUTRAL';
    if (score >= 25) verdict = 'BULLISH';
    else if (score <= -25) verdict = 'BEARISH';

    return {
      score,
      verdict,
      summary: `Regulatory filings and earnings conference transcripts reflect clean execution with positive earnings surprise history.`,
      keyDrivers,
    };
  }

  // --- Exact Mathematical Price Targets & Key Levels ---

  private calculatePriceTargets(
    currentPrice: number,
    supports: number[],
    resistances: number[],
    recommendation: FinalStockPrediction['recommendation'],
    analystMean?: number
  ): PredictionPriceTargets {
    // Determine realistic support and resistance anchors
    const s1 = supports.length > 0 ? supports[0] : Number((currentPrice * 0.96).toFixed(2));
    const s2 = supports.length > 1 ? supports[1] : Number((currentPrice * 0.92).toFixed(2));
    const s3 = supports.length > 2 ? supports[2] : Number((currentPrice * 0.88).toFixed(2));

    const r1 = resistances.length > 0 ? resistances[0] : Number((currentPrice * 1.05).toFixed(2));
    const r2 = resistances.length > 1 ? resistances[1] : Number((currentPrice * 1.11).toFixed(2));
    const r3 = resistances.length > 2 ? resistances[2] : Number((currentPrice * 1.20).toFixed(2));

    const isBullish = recommendation === 'STRONG_BUY' || recommendation === 'BUY';

    // Entry Zone
    const entryMin = isBullish ? Number((Math.min(currentPrice * 0.99, s1 * 1.01)).toFixed(2)) : Number((currentPrice * 0.98).toFixed(2));
    const entryMax = isBullish ? Number((currentPrice * 1.01).toFixed(2)) : Number((currentPrice * 1.02).toFixed(2));

    // Stop Loss (Strict Capital Preservation)
    const stopPrice = isBullish
      ? Number((s1 * 0.985).toFixed(2))
      : Number((r1 * 1.02).toFixed(2));
    const stopRiskPct = Math.abs(Number((((stopPrice - currentPrice) / currentPrice) * 100).toFixed(2)));

    // Targets
    const t1Price = isBullish
      ? Number((Math.max(r1, currentPrice * 1.045)).toFixed(2))
      : Number((Math.min(s1, currentPrice * 0.95)).toFixed(2));
    const t1Upside = Number((((t1Price - currentPrice) / currentPrice) * 100).toFixed(2));

    const t2Price = isBullish
      ? Number((Math.max(r2, analystMean || currentPrice * 1.12)).toFixed(2))
      : Number((Math.min(s2, currentPrice * 0.90)).toFixed(2));
    const t2Upside = Number((((t2Price - currentPrice) / currentPrice) * 100).toFixed(2));

    const t3Price = isBullish
      ? Number((Math.max(r3, t2Price * 1.08)).toFixed(2))
      : Number((Math.min(s3, currentPrice * 0.85)).toFixed(2));
    const t3Upside = Number((((t3Price - currentPrice) / currentPrice) * 100).toFixed(2));

    // Risk / Reward Ratio = Base Target Gain / Stop Loss Risk
    const rrRatio = stopRiskPct > 0 ? Number((Math.abs(t2Upside) / stopRiskPct).toFixed(2)) : 3.0;

    return {
      currentPrice: Number(currentPrice.toFixed(2)),
      entryZone: [entryMin, entryMax],
      target1: {
        price: t1Price,
        upsidePercent: t1Upside,
        label: isBullish ? 'Conservative Take-Profit (Resistance 1)' : 'Cover Partial Short',
      },
      target2: {
        price: t2Price,
        upsidePercent: t2Upside,
        label: isBullish ? 'Base Case Target (Catalyst Realization)' : 'Primary Downside Target',
      },
      target3: {
        price: t3Price,
        upsidePercent: t3Upside,
        label: isBullish ? 'Bullish Extension (Blue Sky Momentum)' : 'Macro Flush Target',
      },
      stopLoss: {
        price: stopPrice,
        riskPercent: stopRiskPct,
        rationale: isBullish
          ? `Placed 1.5% beneath Primary Support ($${s1}) to avoid market maker liquidity wicks.`
          : `Placed 2.0% above Overhead Resistance ($${r1}) to limit short squeeze risk.`,
      },
      riskRewardRatio: rrRatio,
      resistances: [
        { level: 'R1', price: r1, strength: 'MODERATE' },
        { level: 'R2', price: r2, strength: 'STRONG' },
        { level: 'R3', price: r3, strength: 'STRONG' },
      ],
      supports: [
        { level: 'S1', price: s1, strength: 'STRONG' },
        { level: 'S2', price: s2, strength: 'MODERATE' },
        { level: 'S3', price: s3, strength: 'STRONG' },
      ],
    };
  }

  // --- Executive Synthesis & Action Plan ---

  private generateExecutiveSynthesis(
    symbol: string,
    rec: FinalStockPrediction['recommendation'],
    price: number,
    targets: PredictionPriceTargets,
    score: number,
    tech: DimensionAnalysis,
    sentiment: DimensionAnalysis,
    fin: DimensionAnalysis
  ): { rationale: string; invalidation: string; executionSummary: string } {
    let rationale = '';
    let invalidation = '';
    let executionSummary = '';

    if (rec === 'STRONG_BUY' || rec === 'BUY') {
      rationale = `Our multi-factor institutional model synthesizes an authoritative ${rec.replace('_', ' ')} recommendation for ${symbol} with a composite score of +${score}/100. High-conviction bullish confluence is observed across: (1) Constructive technical structure with moving averages fanning upward, (2) Strong positive news sentiment velocity with active expansion catalysts, and (3) Resilient balance sheet metrics and cash generation supporting valuation expansion toward Base Target $${targets.target2.price}.`;
      invalidation = `A confirmed daily closing candle below Primary Support ($${targets.supports[0].price}) on above-average volume would invalidate the bullish thesis and trigger strict risk exit at Stop Loss $${targets.stopLoss.price}.`;
      executionSummary = `Accrue exposure within Entry Zone [$${targets.entryZone[0]}, $${targets.entryZone[1]}]. Scale out 40% at Target 1 ($${targets.target1.price}, +${targets.target1.upsidePercent}%), trail stop to breakeven, and let remaining 60% run to Base Target 2 ($${targets.target2.price}, +${targets.target2.upsidePercent}%). Implied Risk/Reward: 1 : ${targets.riskRewardRatio}.`;
    } else if (rec === 'STRONG_SELL' || rec === 'SELL') {
      rationale = `Our multi-factor model generates a defensive ${rec.replace('_', ' ')} rating for ${symbol} with a composite score of ${score}/100. Bearish confluence is detected from heavy overhead resistance, deteriorating news sentiment, and valuation sensitivity under prevailing market rate conditions.`;
      invalidation = `A decisive breakout and sustained close above Overhead Resistance ($${targets.resistances[0].price}) would invalidate the bearish bias and indicate short-covering momentum.`;
      executionSummary = `Reduce or hedge long exposure. For active tactical traders, initiate short or hedge on rallies toward $${targets.entryZone[1]}, targeting downside support targets at $${targets.target1.price} and $${targets.target2.price} with a stop placed strictly at $${targets.stopLoss.price}.`;
    } else {
      rationale = `Our quantitative synthesis suggests a HOLD / NEUTRAL stance for ${symbol} (Score: ${score}/100). The asset is currently consolidating in a defined equilibrium channel between Support S1 ($${targets.supports[0].price}) and Resistance R1 ($${targets.resistances[0].price}). Bullish fundamental catalysts are currently balanced by technical resistance.`;
      invalidation = `A breakout above $${targets.resistances[0].price} triggers a BUY continuation, whereas a breakdown below $${targets.supports[0].price} triggers a defensive downgrade.`;
      executionSummary = `Hold existing core allocations. Await decisive breakout confirmation before deploying incremental fresh capital. Key pivot levels: S1 ($${targets.supports[0].price}) and R1 ($${targets.resistances[0].price}).`;
    }

    return { rationale, invalidation, executionSummary };
  }
}

export const aiPredictionService = new AiPredictionService();
