import { NextRequest, NextResponse } from 'next/server';
import { sentimentService } from '@/services/sentimentService';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'NVDA';

    const result = await sentimentService.analyzeStockSentiment(symbol);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Sentiment API error:', error);
    return NextResponse.json({ error: error.message || 'Sentiment analysis service failed' }, { status: 500 });
  }
}
