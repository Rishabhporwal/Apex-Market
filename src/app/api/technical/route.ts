import { NextRequest, NextResponse } from 'next/server';
import { marketDataService } from '@/services/marketDataService';
import { technicalService } from '@/services/technicalService';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'NVDA';
    const timeframe = (searchParams.get('timeframe') as any) || '1y';

    const candles = await marketDataService.getHistoricalCandles(symbol, timeframe, '1d');
    const summary = technicalService.getTechnicalSummary(symbol, candles);
    const indicatorSeries = technicalService.computeIndicators(candles);

    return NextResponse.json({
      symbol,
      summary,
      indicatorSeries: indicatorSeries.slice(-60), // Latest 60 periods for quick chart/gauge inspection
    });
  } catch (error: any) {
    console.error('Technical API error:', error);
    return NextResponse.json({ error: error.message || 'Technical analysis service failed' }, { status: 500 });
  }
}
