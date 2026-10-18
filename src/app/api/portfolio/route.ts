import { NextRequest, NextResponse } from 'next/server';
import { portfolioService } from '@/services/portfolioService';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const state = await portfolioService.getPortfolioState();
    return NextResponse.json(state);
  } catch (error: any) {
    console.error('Portfolio GET API error:', error);
    return NextResponse.json({ error: error.message || 'Portfolio service failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action;

    if (action === 'trade') {
      const { symbol, type, shares } = body;
      const res = await portfolioService.executeOrder(symbol, type, Number(shares));
      return NextResponse.json(res);
    }

    if (action === 'reset') {
      const initialCash = Number(body.initialCash) || 100000;
      const state = portfolioService.resetPortfolio(initialCash);
      return NextResponse.json({ success: true, message: 'Portfolio reset', state });
    }

    if (action === 'watchlist_add') {
      const { watchlistId, symbol } = body;
      const success = portfolioService.addToWatchlist(watchlistId || 'wl-default', symbol);
      const state = await portfolioService.getPortfolioState();
      return NextResponse.json({ success, state });
    }

    if (action === 'watchlist_remove') {
      const { watchlistId, symbol } = body;
      const success = portfolioService.removeFromWatchlist(watchlistId || 'wl-default', symbol);
      const state = await portfolioService.getPortfolioState();
      return NextResponse.json({ success, state });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error: any) {
    console.error('Portfolio POST API error:', error);
    return NextResponse.json({ error: error.message || 'Portfolio service action failed' }, { status: 500 });
  }
}
