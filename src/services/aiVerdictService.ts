import { marketDataService } from '@/services/marketDataService';
import { financialsService } from '@/services/financialsService';
import { getNewsDrivers } from '@/services/newsDrivers';
import { computeLevels, getStopLossAndTargets } from '@/services/levelsService';
import { scoreVerdict } from '@/services/quantEngine';
import { llmService } from '@/services/llmService';
import type { Candle, StockQuote } from '@/types';
import type { AiVerdict, VerdictAction, VerdictHorizon, VerdictFundamentals } from '@/types/verdict';

const DISCLAIMER =
  'This verdict is AI-generated research for informational purposes only. It is not financial advice and should not be relied upon to make investment decisions. Always do your own research and consult a licensed financial adviser before trading.';

class AiVerdictService {
  async generateVerdict(symbol: string): Promise<AiVerdict> {
    const clean = symbol.trim().toUpperCase();
    if (!clean) throw new Error('Symbol is required');

    // ---- Gather inputs; each fetch degrades independently -------------------
    let quote: StockQuote | null = null;
    let candles: Candle[] = [];
    let news = { newsItems: [], bullish: [], bearish: [], sentimentScore: 0 } as Awaited<ReturnType<typeof getNewsDrivers>>;
    let fundamentals: VerdictFundamentals | undefined;
    let narrative: string | undefined;
    let llmTone: 'BULLISH' | 'NEUTRAL' | 'BEARISH' | undefined;

    const settled = await Promise.allSettled([
      marketDataService.getQuote(clean),
      // 2y of daily candles: 12-1 momentum needs ~13 months of history.
      marketDataService.getHistoricalCandles(clean, '2y', '1d'),
      getNewsDrivers(clean),
      financialsService.getKeyFinancials(clean).catch(() => null),
      this.fetchEdgarFundamentals(clean),
    ]);

    if (settled[0].status === 'fulfilled') quote = settled[0].value;
    else console.warn(`[aiVerdict] quote failed for ${clean}:`, settled[0].reason);
    if (settled[1].status === 'fulfilled') candles = settled[1].value;
    else console.warn(`[aiVerdict] candles failed for ${clean}:`, settled[1].reason);
    if (settled[2].status === 'fulfilled') news = settled[2].value;
    else console.warn(`[aiVerdict] news failed for ${clean}:`, settled[2].reason);
    const keyFin = settled[3].status === 'fulfilled' ? settled[3].value : null;
    const edgar = settled[4].status === 'fulfilled' ? settled[4].value : null;

    const price = quote?.price || candles[candles.length - 1]?.close || 0;
    if (!price) throw new Error(`Unable to determine price for ${clean}`);
    const name = quote?.name || clean;

    // ---- Technicals ---------------------------------------------------------
    let sma20: number | undefined;
    let sma50: number | undefined;
    let sma200: number | undefined;
    let levels: ReturnType<typeof computeLevels> | null = null;
    try {
      levels = computeLevels(candles);
      sma20 = levels.sma20;
      sma50 = levels.sma50;
      sma200 = levels.sma200;
    } catch (err) {
      console.warn(`[aiVerdict] levels failed for ${clean}:`, err);
    }

    // ---- Quantitative score via the shared quant core -----------------------
    // (same pure logic the backtester runs — single source of truth)
    const fundSrc = edgar ?? this.fromYahooFinancials(keyFin);
    const quant = scoreVerdict({
      price,
      candles,
      sentimentScore: news.sentimentScore,
      fundamentals: fundSrc
        ? {
            revenueGrowthYoY: fundSrc.revenueGrowthYoY,
            netMargin: fundSrc.netMargin,
            roe: fundSrc.roe,
            peRatio: fundSrc.peRatio,
          }
        : undefined,
    });
    const { score, confidence } = quant;
    let action: VerdictAction = quant.action;
    const trend = quant.trend;
    const rsi14 = levels?.rsi14;
    if (fundSrc) fundamentals = fundSrc;

    // Horizon: swing when strong trend + RSI extreme, else long
    const rsiExtreme = rsi14 !== undefined && (rsi14 < 30 || rsi14 > 70);
    const trendStrong = trend !== 'sideways';
    const horizon: VerdictHorizon = trendStrong && rsiExtreme ? 'swing' : trendStrong ? 'swing' : 'long';

    // ---- LLM narrative (only when a provider key exists) --------------------
    if (process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) {
      try {
        const llm = await llmService.runDeepAnalysis({
          symbol: clean,
          companyName: name,
          currentPrice: price,
          technicalSummary: { rsi14, trendShortTerm: trend === 'up' ? 'BULLISH' : trend === 'down' ? 'BEARISH' : 'NEUTRAL' },
          sentimentScore: news.sentimentScore,
          newsHeadlines: news.newsItems.map((n) => n.title),
          keyFinancials: keyFin,
        });
        narrative = llm.deepAnalysis;
        llmTone = llm.analystToneAssessment;
      } catch (err) {
        console.warn(`[aiVerdict] LLM analysis failed for ${clean}:`, err);
      }
    }

    // Soft LLM vote: adjust action only when quant score sits within ±15 of a boundary
    if (llmTone) {
      const boundaries = [-35, -15, 15, 35];
      const nearBoundary = boundaries.some((b) => Math.abs(score - b) <= 15);
      if (nearBoundary) {
        if (llmTone === 'BULLISH' && action === 'HOLD' && score >= -15) action = 'BUY';
        else if (llmTone === 'BEARISH' && action === 'HOLD' && score <= 15) action = 'SELL';
        else if (llmTone === 'BULLISH' && action === 'SELL' && score >= -35) action = 'HOLD';
        else if (llmTone === 'BEARISH' && action === 'BUY' && score <= 35) action = 'HOLD';
      }
    }

    // ---- Levels & strategy --------------------------------------------------
    const supports = levels?.supports ?? [];
    const resistances = levels?.resistances ?? [];
    let stopTargets: ReturnType<typeof getStopLossAndTargets> = {};
    try {
      stopTargets = getStopLossAndTargets(candles, action);
    } catch (err) {
      console.warn(`[aiVerdict] stop/targets failed for ${clean}:`, err);
    }

    const strategy = this.buildStrategy({
      action,
      price,
      name,
      trend,
      supports,
      resistances,
      stop: stopTargets.stopLoss,
      t1: stopTargets.target1,
      t2: stopTargets.target2,
      rsi14,
      atr14: levels?.atr14,
      week52High: levels?.week52High,
      week52Low: levels?.week52Low,
    });

    const summary = this.buildSummary(clean, name, action, score, trend, rsi14, news.sentimentScore);

    return {
      symbol: clean,
      name,
      price: Math.round(price * 100) / 100,
      asOf: Date.now(),
      verdict: { action, confidence, horizon, summary },
      levels: {
        target1: stopTargets.target1,
        target2: stopTargets.target2,
        stopLoss: stopTargets.stopLoss,
        supports,
        resistances,
        sma20,
        sma50,
        sma200,
        rsi14,
        atr14: levels?.atr14,
        week52High: levels?.week52High,
        week52Low: levels?.week52Low,
      },
      drivers: {
        bullish: news.bullish,
        bearish: news.bearish,
        newsItems: news.newsItems,
      },
      strategy,
      fundamentals,
      technicals: { trend, rsi14, sentimentScore: news.sentimentScore },
      aiNarrative: narrative,
      disclaimer: DISCLAIMER,
    };
  }

  /** EDGAR warehouse fundamentals; null when missing/unavailable — never throws. */
  private async fetchEdgarFundamentals(symbol: string): Promise<VerdictFundamentals | null> {
    try {
      const { edgarService } = await import('@/services/edgarService');
      if (!(await edgarService.isWarehouseReady())) return null;
      const rows = await edgarService.getScreenerResults({ searchQuery: symbol, limit: 10 });
      const row = rows.find((r) => r.symbol === symbol.toUpperCase());
      if (!row) return null;
      const fy = row.fiscalYear ? ` (FY${row.fiscalYear}${row.fiscalPeriod ? ` ${row.fiscalPeriod}` : ''})` : '';
      return {
        revenueGrowthYoY: row.revenueGrowthYoY,
        netMargin: row.netMargin,
        roe: row.roe,
        peRatio: row.peRatio,
        source: `SEC EDGAR company facts${fy}`,
      };
    } catch (err) {
      console.warn(`[aiVerdict] EDGAR fundamentals unavailable for ${symbol}:`, err);
      return null;
    }
  }

  /** Fallback fundamentals from Yahoo key financials. */
  private fromYahooFinancials(
    keyFin: Awaited<ReturnType<typeof financialsService.getKeyFinancials>> | null
  ): VerdictFundamentals | null {
    if (!keyFin) return null;
    const out: VerdictFundamentals = { source: 'Yahoo Finance' };
    if (keyFin.quarterlyRevenueGrowth !== undefined) out.revenueGrowthYoY = keyFin.quarterlyRevenueGrowth * 100;
    if (keyFin.profitMargin !== undefined) out.netMargin = keyFin.profitMargin * 100;
    if (keyFin.returnOnEquity !== undefined) out.roe = keyFin.returnOnEquity * 100;
    if (keyFin.trailingPE !== undefined) out.peRatio = keyFin.trailingPE;
    return out;
  }

  private buildStrategy(args: {
    action: VerdictAction;
    price: number;
    name: string;
    trend: 'up' | 'down' | 'sideways';
    supports: number[];
    resistances: number[];
    stop?: number;
    t1?: number;
    t2?: number;
    rsi14?: number;
    atr14?: number;
    week52High?: number;
    week52Low?: number;
  }): AiVerdict['strategy'] {
    const { action, price, name, trend, supports, resistances, stop, t1, t2 } = args;
    const p = (v: number | undefined) => (v === undefined ? undefined : `$${v.toFixed(2)}`);

    const headline =
      action === 'BUY'
        ? `${name}: constructive setup — the model rates ${name.split(' ')[0]} a BUY with a ${trend === 'up' ? 'rising' : trend === 'down' ? 'mixed' : 'flat'} trend backdrop.`
        : action === 'SELL'
        ? `${name}: caution warranted — the model rates ${name.split(' ')[0]} a SELL; trend and momentum argue against new buying.`
        : `${name}: no clear edge right now — the model rates ${name.split(' ')[0]} ${action}; wait for a stronger signal before committing capital.`;

    const plan: string[] = [];
    const minGap = Math.max(price * 0.005, args.atr14 ?? 0); // entry zone should be at least one ATR deep (min 0.5% of price)
    const zoneCandidates = supports.filter((s) => s < price - minGap).sort((a, b) => b - a);
    const nearestSupport = zoneCandidates.length
      ? zoneCandidates[0]
      : // No meaningful support below: fall back to an ATR-based entry buffer (~1.5×ATR or 1.5% of price).
        price - Math.max((args.atr14 ?? price * 0.01) * 1.5, price * 0.015);
    if (action === 'BUY') {
      if (nearestSupport !== undefined && nearestSupport < price) {
        plan.push(`Consider building a position in the entry zone between ${p(nearestSupport)} (nearest support) and ${p(price)} (current price).`);
      }
      if (t1) plan.push(`First profit target: ${p(t1)}${t2 ? `, stretch target: ${p(t2)}` : ''}. Scale out gradually rather than selling everything at once.`);
      if (stop) plan.push(`Protect capital: if the price closes below ${p(stop)}, exit the position — that level breaks the support the idea is built on.`);
    } else if (action === 'SELL') {
      if (stop) plan.push(`For existing holders, the risk line is ${p(stop)} — a close above it invalidates the bearish case; consider trimming before that.`);
      if (t1) plan.push(`Downside objective: ${p(t1)}${t2 ? `, then ${p(t2)}` : ''}. Do not chase the stock lower.`);
      plan.push('New money should stay on the sidelines until trend and momentum improve.');
    } else {
      if (nearestSupport !== undefined) plan.push(`Watch the ${p(nearestSupport)} support area — a firm hold there with improving news could set up a buying opportunity.`);
      if (resistances.length) plan.push(`Overhead resistance sits near ${p(resistances[0])}; a breakout above it on strong volume would be the bullish trigger.`);
      plan.push('Re-run this verdict after the next earnings report or a significant news event.');
    }
    if (args.rsi14 !== undefined) {
      if (args.rsi14 > 70) plan.push(`Momentum is stretched (RSI ${args.rsi14.toFixed(0)}) — the stock is overbought, so avoid buying into a spike.`);
      else if (args.rsi14 < 30) plan.push(`Momentum is washed out (RSI ${args.rsi14.toFixed(0)}) — the stock is oversold, so avoid panic-selling at the lows.`);
    }

    const riskNote = stop
      ? `Risk is defined by the stop at ${p(stop)} (${Math.abs(((price - stop) / price) * 100).toFixed(1)}% from the current price of ${p(price)}). Position size so that hitting the stop costs no more than 1–2% of your total portfolio.`
      : `Insufficient price history to compute a precise stop. If trading, use a hard stop no further than 5–8% below your entry near ${p(price)} and keep the position small.`;

    return { headline, entry: nearestSupport !== undefined ? `${p(nearestSupport)} – ${p(price)}` : undefined, plan, riskNote };
  }

  private buildSummary(
    symbol: string,
    name: string,
    action: VerdictAction,
    score: number,
    trend: string,
    rsi14: number | undefined,
    sentimentScore: number
  ): string {
    const trendText = trend === 'up' ? 'trading above its key moving averages (long-term uptrend)' : trend === 'down' ? 'trading below its key moving averages (long-term downtrend)' : 'moving sideways between its key averages';
    const rsiText = rsi14 === undefined ? '' : rsi14 > 70 ? ' momentum is overbought' : rsi14 < 30 ? ' momentum is oversold' : ' momentum is in the neutral zone';
    const newsText = sentimentScore > 10 ? ' news flow is supportive' : sentimentScore < -10 ? ' news flow is negative' : ' news flow is mixed';
    const tone = action === 'BUY' ? 'favorable' : action === 'SELL' ? 'unfavorable' : 'balanced';
    return `${name} (${symbol}) scores ${score > 0 ? '+' : ''}${score}/100. The stock is ${trendText},${rsiText}${newsText}, giving a ${tone} overall picture. Composite rating: ${action}.`;
  }
}

export const aiVerdictService = new AiVerdictService();
export default aiVerdictService;
