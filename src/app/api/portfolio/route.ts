/**
 * BFF portfolio routes — trade logic runs in portfolioService (this process),
 * durable state persists per client via the gateway (/api/portfolio-state →
 * svc-userdata). Identity: same `apex_cid` cookie scheme as the watchlist
 * route — an anonymous device id, NOT auth.
 */
import { NextRequest, NextResponse } from 'next/server';
import { portfolioService } from '@/services/portfolioService';

export const runtime = 'nodejs';

const CID_COOKIE = 'apex_cid';
const ONE_YEAR_S = 60 * 60 * 24 * 365;

function clientIdentity(req: NextRequest): { clientId: string; setCookie: boolean } {
  const existing = req.cookies.get(CID_COOKIE)?.value;
  if (existing) return { clientId: existing, setCookie: false };
  return { clientId: crypto.randomUUID(), setCookie: true };
}

function withCookie(res: NextResponse, clientId: string, setCookie: boolean): NextResponse {
  if (setCookie) {
    res.cookies.set(CID_COOKIE, clientId, {
      httpOnly: false,
      maxAge: ONE_YEAR_S,
      path: '/',
      sameSite: 'lax',
    });
  }
  return res;
}

export async function GET(req: NextRequest) {
  try {
    const { clientId, setCookie } = clientIdentity(req);
    const state = await portfolioService.getPortfolioState(clientId);
    return withCookie(NextResponse.json(state), clientId, setCookie);
  } catch (error: any) {
    console.error('Portfolio GET API error:', error);
    return NextResponse.json({ error: error.message || 'Portfolio service failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body.action;
    const { clientId, setCookie } = clientIdentity(req);

    if (action === 'trade') {
      const { symbol, type, shares } = body;
      const res = await portfolioService.executeOrder(symbol, type, Number(shares), clientId);
      return withCookie(NextResponse.json(res), clientId, setCookie);
    }

    if (action === 'reset') {
      const initialCash = Number(body.initialCash) || 100000;
      const state = await portfolioService.resetPortfolio(initialCash, clientId);
      return withCookie(NextResponse.json({ success: true, message: 'Portfolio reset', state }), clientId, setCookie);
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error: any) {
    console.error('Portfolio POST API error:', error);
    return NextResponse.json({ error: error.message || 'Portfolio service action failed' }, { status: 500 });
  }
}
