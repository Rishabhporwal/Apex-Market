import { NextRequest, NextResponse } from 'next/server';
import { filingsService } from '@/services/filingsService';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  // Microservice mesh first (when configured); local implementation otherwise
  const proxied = await proxyToGateway(req, '/api/filings');
  if (proxied) return proxied;

  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'NVDA';
    const type = searchParams.get('type') || 'all';

    if (type === 'filings') {
      const filings = await filingsService.getSecFilings(symbol);
      return NextResponse.json(filings);
    }

    if (type === 'transcripts') {
      const transcripts = await filingsService.getEarningsTranscriptHighlights(symbol);
      return NextResponse.json(transcripts);
    }

    const [filings, transcripts] = await Promise.all([
      filingsService.getSecFilings(symbol),
      filingsService.getEarningsTranscriptHighlights(symbol),
    ]);

    return NextResponse.json({
      filings,
      transcripts,
    });
  } catch (error: any) {
    console.error('Filings API error:', error);
    return NextResponse.json({ error: error.message || 'Filings service failed' }, { status: 500 });
  }
}
