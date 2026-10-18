import { Candle, TechnicalIndicatorData, TechnicalSummary } from '@/types';

class TechnicalService {
  /**
   * Compute comprehensive technical indicator series over candles
   */
  computeIndicators(candles: Candle[]): TechnicalIndicatorData[] {
    if (!candles || candles.length === 0) return [];

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const sma20 = this.calculateSMA(closes, 20);
    const sma50 = this.calculateSMA(closes, 50);
    const sma200 = this.calculateSMA(closes, 200);
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const rsi14 = this.calculateRSI(closes, 14);
    const macdSeries = this.calculateMACD(closes, 12, 26, 9);
    const bollingerSeries = this.calculateBollinger(closes, 20, 2);
    const vwapSeries = this.calculateVWAP(highs, lows, closes, volumes);

    return candles.map((c, i) => ({
      time: c.time,
      sma20: sma20[i] !== null ? Number(sma20[i]!.toFixed(2)) : undefined,
      sma50: sma50[i] !== null ? Number(sma50[i]!.toFixed(2)) : undefined,
      sma200: sma200[i] !== null ? Number(sma200[i]!.toFixed(2)) : undefined,
      ema9: ema9[i] !== null ? Number(ema9[i]!.toFixed(2)) : undefined,
      ema21: ema21[i] !== null ? Number(ema21[i]!.toFixed(2)) : undefined,
      rsi14: rsi14[i] !== null ? Number(rsi14[i]!.toFixed(2)) : undefined,
      macd: macdSeries[i] ? {
        macd: Number(macdSeries[i]!.macd.toFixed(2)),
        signal: Number(macdSeries[i]!.signal.toFixed(2)),
        histogram: Number(macdSeries[i]!.histogram.toFixed(2)),
      } : undefined,
      bollinger: bollingerSeries[i] ? {
        upper: Number(bollingerSeries[i]!.upper.toFixed(2)),
        middle: Number(bollingerSeries[i]!.middle.toFixed(2)),
        lower: Number(bollingerSeries[i]!.lower.toFixed(2)),
      } : undefined,
      vwap: vwapSeries[i] !== null ? Number(vwapSeries[i]!.toFixed(2)) : undefined,
    }));
  }

  /**
   * Summarize current technical condition and overall actionable signal
   */
  getTechnicalSummary(symbol: string, candles: Candle[]): TechnicalSummary {
    if (!candles || candles.length < 20) {
      return {
        symbol,
        currentPrice: candles?.[candles.length - 1]?.close || 0,
        rsi14: 50,
        rsiCondition: 'NEUTRAL',
        trendShortTerm: 'NEUTRAL',
        trendLongTerm: 'NEUTRAL',
        goldenCross: false,
        deathCross: false,
        macdCross: 'NEUTRAL',
        supportLevels: [],
        resistanceLevels: [],
        overallSignal: 'HOLD',
      };
    }

    const currentPrice = candles[candles.length - 1].close;
    const indicatorSeries = this.computeIndicators(candles);
    const latest = indicatorSeries[indicatorSeries.length - 1];
    const prev = indicatorSeries[indicatorSeries.length - 2];

    const currentRSI = latest.rsi14 ?? 50;
    let rsiCondition: TechnicalSummary['rsiCondition'] = 'NEUTRAL';
    if (currentRSI >= 70) rsiCondition = 'OVERBOUGHT';
    else if (currentRSI <= 30) rsiCondition = 'OVERSOLD';

    // Short term trend based on EMA 9 vs EMA 21 and price vs SMA 20
    const shortEmaFast = latest.ema9 ?? currentPrice;
    const shortEmaSlow = latest.ema21 ?? currentPrice;
    const trendShortTerm: TechnicalSummary['trendShortTerm'] =
      shortEmaFast > shortEmaSlow && currentPrice > (latest.sma20 ?? currentPrice)
        ? 'BULLISH'
        : shortEmaFast < shortEmaSlow && currentPrice < (latest.sma20 ?? currentPrice)
        ? 'BEARISH'
        : 'NEUTRAL';

    // Long term trend based on SMA 50 and SMA 200
    const sma50 = latest.sma50 ?? currentPrice;
    const sma200 = latest.sma200 ?? currentPrice;
    const trendLongTerm: TechnicalSummary['trendLongTerm'] =
      currentPrice > sma50 && sma50 > sma200
        ? 'BULLISH'
        : currentPrice < sma50 && sma50 < sma200
        ? 'BEARISH'
        : 'NEUTRAL';

    // Golden cross & Death cross
    const goldenCross = sma50 > sma200 && (prev.sma50 ?? 0) <= (prev.sma200 ?? 0);
    const deathCross = sma50 < sma200 && (prev.sma50 ?? 0) >= (prev.sma200 ?? 0);

    // MACD Cross
    let macdCross: TechnicalSummary['macdCross'] = 'NEUTRAL';
    if (latest.macd && prev.macd) {
      if (latest.macd.macd > latest.macd.signal && prev.macd.macd <= prev.macd.signal) {
        macdCross = 'BULLISH_CROSS';
      } else if (latest.macd.macd < latest.macd.signal && prev.macd.macd >= prev.macd.signal) {
        macdCross = 'BEARISH_CROSS';
      }
    }

    // Support & Resistance via Pivot Highs/Lows
    const { supports, resistances } = this.calculatePivotLevels(candles);

    // Score overall signal
    let bullPoints = 0;
    let bearPoints = 0;

    if (trendShortTerm === 'BULLISH') bullPoints += 2;
    if (trendShortTerm === 'BEARISH') bearPoints += 2;

    if (trendLongTerm === 'BULLISH') bullPoints += 2;
    if (trendLongTerm === 'BEARISH') bearPoints += 2;

    if (currentRSI < 35) bullPoints += 1.5; // Mean reversion buy
    if (currentRSI > 65) bearPoints += 1.5; // Overbought

    if (latest.macd?.histogram && latest.macd.histogram > 0) bullPoints += 1.5;
    if (latest.macd?.histogram && latest.macd.histogram < 0) bearPoints += 1.5;

    if (macdCross === 'BULLISH_CROSS') bullPoints += 2;
    if (macdCross === 'BEARISH_CROSS') bearPoints += 2;

    let overallSignal: TechnicalSummary['overallSignal'] = 'HOLD';
    const netScore = bullPoints - bearPoints;
    if (netScore >= 4) overallSignal = 'STRONG_BUY';
    else if (netScore >= 1.5) overallSignal = 'BUY';
    else if (netScore <= -4) overallSignal = 'STRONG_SELL';
    else if (netScore <= -1.5) overallSignal = 'SELL';

    return {
      symbol,
      currentPrice,
      rsi14: currentRSI,
      rsiCondition,
      trendShortTerm,
      trendLongTerm,
      goldenCross,
      deathCross,
      macdCross,
      supportLevels: supports.slice(0, 3),
      resistanceLevels: resistances.slice(0, 3),
      overallSignal,
    };
  }

  // --- Mathematical Indicator Calculations ---

  calculateSMA(values: number[], period: number): (number | null)[] {
    const result: (number | null)[] = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) {
        sum -= values[i - period];
      }
      if (i >= period - 1) {
        result.push(sum / period);
      } else {
        result.push(null);
      }
    }
    return result;
  }

  calculateEMA(values: number[], period: number): (number | null)[] {
    const result: (number | null)[] = [];
    const k = 2 / (period + 1);
    let ema: number | null = null;

    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) {
        result.push(null);
      } else if (i === period - 1) {
        // First EMA is SMA
        const sum = values.slice(0, period).reduce((a, b) => a + b, 0);
        ema = sum / period;
        result.push(ema);
      } else {
        ema = values[i] * k + ema! * (1 - k);
        result.push(ema);
      }
    }
    return result;
  }

  calculateRSI(values: number[], period: number = 14): (number | null)[] {
    const result: (number | null)[] = [];
    if (values.length <= period) return values.map(() => null);

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = 0; i < period; i++) {
      result.push(null);
    }

    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));

    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      const gain = diff >= 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }

    return result;
  }

  calculateMACD(
    values: number[],
    fast: number = 12,
    slow: number = 26,
    signalPeriod: number = 9
  ): ({ macd: number; signal: number; histogram: number } | null)[] {
    const emaFast = this.calculateEMA(values, fast);
    const emaSlow = this.calculateEMA(values, slow);

    const macdLine: (number | null)[] = [];
    for (let i = 0; i < values.length; i++) {
      if (emaFast[i] !== null && emaSlow[i] !== null) {
        macdLine.push(emaFast[i]! - emaSlow[i]!);
      } else {
        macdLine.push(null);
      }
    }

    // Filter valid MACD values to compute Signal line
    const validMacdIndices = macdLine
      .map((val, idx) => (val !== null ? idx : null))
      .filter((idx): idx is number => idx !== null);

    const validMacdValues = validMacdIndices.map((idx) => macdLine[idx]!);
    const signalEma = this.calculateEMA(validMacdValues, signalPeriod);

    const result: ({ macd: number; signal: number; histogram: number } | null)[] = values.map(() => null);

    validMacdIndices.forEach((origIdx, validIdx) => {
      const sig = signalEma[validIdx];
      if (sig !== null) {
        const m = macdLine[origIdx]!;
        result[origIdx] = {
          macd: m,
          signal: sig,
          histogram: m - sig,
        };
      }
    });

    return result;
  }

  calculateBollinger(
    values: number[],
    period: number = 20,
    multiplier: number = 2
  ): ({ upper: number; middle: number; lower: number } | null)[] {
    const sma = this.calculateSMA(values, period);
    const result: ({ upper: number; middle: number; lower: number } | null)[] = [];

    for (let i = 0; i < values.length; i++) {
      if (i < period - 1 || sma[i] === null) {
        result.push(null);
        continue;
      }

      const slice = values.slice(i - period + 1, i + 1);
      const mean = sma[i]!;
      const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
      const stdDev = Math.sqrt(variance);

      result.push({
        middle: mean,
        upper: mean + multiplier * stdDev,
        lower: mean - multiplier * stdDev,
      });
    }

    return result;
  }

  calculateVWAP(highs: number[], lows: number[], closes: number[], volumes: number[]): (number | null)[] {
    let cumVolume = 0;
    let cumTypicalPriceVolume = 0;
    const result: (number | null)[] = [];

    for (let i = 0; i < closes.length; i++) {
      const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
      const vol = volumes[i] || 1;
      cumTypicalPriceVolume += typicalPrice * vol;
      cumVolume += vol;
      result.push(cumVolume > 0 ? cumTypicalPriceVolume / cumVolume : typicalPrice);
    }

    return result;
  }

  calculatePivotLevels(candles: Candle[]): { supports: number[]; resistances: number[] } {
    const lookback = Math.min(60, candles.length);
    const slice = candles.slice(-lookback);
    const highs = slice.map((c) => c.high);
    const lows = slice.map((c) => c.low);
    const current = slice[slice.length - 1].close;

    // Sort local extrema
    const distinctHighs = Array.from(new Set(highs.map((h) => Math.round(h * 10) / 10)))
      .filter((h) => h > current)
      .sort((a, b) => a - b);

    const distinctLows = Array.from(new Set(lows.map((l) => Math.round(l * 10) / 10)))
      .filter((l) => l < current)
      .sort((a, b) => b - a);

    return {
      supports: distinctLows.slice(0, 3),
      resistances: distinctHighs.slice(0, 3),
    };
  }
}

export const technicalService = new TechnicalService();
