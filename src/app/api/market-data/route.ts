import { NextRequest, NextResponse } from 'next/server';
import { marketDataService } from '@/services/marketDataService';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  // Microservice mesh first (when configured) for the types the gateway serves
  const { searchParams: probe } = new URL(req.url);
  const probeType = probe.get('type') || 'quote';
  const probeSymbol = probe.get('symbol') || 'NVDA';
  let gatewayPath: string | null = null;
  if (probeType === 'quote') gatewayPath = `/api/quote/${encodeURIComponent(probeSymbol)}`;
  else if (probeType === 'candles') gatewayPath = `/api/candles/${encodeURIComponent(probeSymbol)}`;
  else if (probeType === 'indices') gatewayPath = '/api/indices';
  if (gatewayPath) {
    const proxied = await proxyToGateway(req, gatewayPath);
    if (proxied) return proxied;
  }

  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type') || 'quote';
    const symbol = searchParams.get('symbol') || 'NVDA';

    switch (type) {
      case 'quote': {
        const quote = await marketDataService.getQuote(symbol);
        return NextResponse.json(quote);
      }
      case 'batch': {
        const symbolsParam = searchParams.get('symbols') || 'AAPL,MSFT,NVDA';
        const symbols = symbolsParam.split(',').map((s) => s.trim());
        const quotes = await marketDataService.getBatchQuotes(symbols);
        return NextResponse.json(quotes);
      }
      case 'candles': {
        const timeframe = (searchParams.get('timeframe') as any) || '1y';
        const interval = (searchParams.get('interval') as any) || '1d';
        const candles = await marketDataService.getHistoricalCandles(symbol, timeframe, interval);
        return NextResponse.json(candles);
      }
      case 'search': {
        const query = searchParams.get('q') || '';
        const results = await marketDataService.searchSymbols(query);
        return NextResponse.json(results);
      }
      case 'indices': {
        const indices = await marketDataService.getMarketIndices();
        return NextResponse.json(indices);
      }
      default:
        return NextResponse.json({ error: 'Invalid type requested' }, { status: 400 });
    }
  } catch (error: any) {
    console.error('Market Data API error:', error);
    return NextResponse.json({ error: error.message || 'Market data service failed' }, { status: 500 });
  }
}
