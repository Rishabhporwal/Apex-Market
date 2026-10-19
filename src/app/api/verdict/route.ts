import { NextRequest, NextResponse } from 'next/server';
import { aiVerdictService } from '@/services/aiVerdictService';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Microservice mesh first (when configured); local implementation otherwise
  const proxied = await proxyToGateway(request, '/api/verdict');
  if (proxied) return proxied;

  const symbol = request.nextUrl.searchParams.get('symbol')?.trim();

  if (!symbol) {
    return NextResponse.json({ error: 'Missing required query parameter: symbol' }, { status: 400 });
  }

  try {
    const verdict = await aiVerdictService.generateVerdict(symbol);
    return NextResponse.json(verdict);
  } catch (error) {
    console.error(`[api/verdict] failed for ${symbol}:`, error);
    return NextResponse.json(
      { error: `Failed to generate verdict for ${symbol.toUpperCase()}` },
      { status: 500 }
    );
  }
}
