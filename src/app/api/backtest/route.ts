import { NextRequest, NextResponse } from 'next/server';
import { backtestService } from '@/services/backtestService';
import { BacktestParams } from '@/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body: BacktestParams = await req.json();

    if (!body.symbol) {
      return NextResponse.json({ error: 'Ticker symbol is required' }, { status: 400 });
    }

    const defaultParams: BacktestParams = {
      symbol: body.symbol.toUpperCase(),
      strategy: body.strategy || 'MA_CROSSOVER',
      initialCapital: Number(body.initialCapital) || 10000,
      timeframe: body.timeframe || '1y',
      fastPeriod: body.fastPeriod ? Number(body.fastPeriod) : undefined,
      slowPeriod: body.slowPeriod ? Number(body.slowPeriod) : undefined,
      rsiOverbought: body.rsiOverbought ? Number(body.rsiOverbought) : undefined,
      rsiOversold: body.rsiOversold ? Number(body.rsiOversold) : undefined,
      stopLossPercent: body.stopLossPercent ? Number(body.stopLossPercent) : undefined,
      takeProfitPercent: body.takeProfitPercent ? Number(body.takeProfitPercent) : undefined,
    };

    const result = await backtestService.runBacktest(defaultParams);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Backtest API error:', error);
    return NextResponse.json({ error: error.message || 'Backtesting service failed' }, { status: 500 });
  }
}
