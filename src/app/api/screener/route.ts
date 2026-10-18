import { NextRequest, NextResponse } from 'next/server';
import { screenerService } from '@/services/screenerService';
import { ScreenerFilter } from '@/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const filters: ScreenerFilter = await req.json();
    const results = await screenerService.screenStocks(filters);
    return NextResponse.json(results);
  } catch (error: any) {
    console.error('Screener API error:', error);
    return NextResponse.json({ error: error.message || 'Screener service failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const sector = searchParams.get('sector') || 'ALL';
    const sortBy = (searchParams.get('sortBy') as any) || 'marketCap';
    const sortOrder = (searchParams.get('sortOrder') as any) || 'desc';

    const results = await screenerService.screenStocks({
      sector,
      sortBy,
      sortOrder,
    });
    return NextResponse.json(results);
  } catch (error: any) {
    console.error('Screener API error:', error);
    return NextResponse.json({ error: error.message || 'Screener service failed' }, { status: 500 });
  }
}
