import { NextRequest, NextResponse } from 'next/server';
import { aiPredictionService } from '@/services/aiPredictionService';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'NVDA';

    const prediction = await aiPredictionService.generatePrediction(symbol);
    return NextResponse.json(prediction);
  } catch (error: any) {
    console.error('AI Prediction API error:', error);
    return NextResponse.json({ error: error.message || 'AI prediction synthesis failed' }, { status: 500 });
  }
}
