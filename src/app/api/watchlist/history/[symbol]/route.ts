import { NextRequest, NextResponse } from 'next/server';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

const CID_COOKIE = 'apex_cid';
const ONE_YEAR_S = 60 * 60 * 24 * 365;

function clientIdentity(req: NextRequest): { clientId: string; setCookie: boolean } {
  const existing = req.cookies.get(CID_COOKIE)?.value;
  if (existing) return { clientId: existing, setCookie: false };
  return { clientId: crypto.randomUUID(), setCookie: true };
}

// GET /api/watchlist/history/TSLA → svc-userdata GET /history/TSLA
// Score-evolution time series for the verdict chart (public data, no client scoping)
export async function GET(req: NextRequest, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;
  const { clientId, setCookie } = clientIdentity(req);
  const res = await proxyToGateway(req, `/api/watchlist/history/${encodeURIComponent(symbol.toUpperCase())}`, { headers: { 'x-client-id': clientId } });
  if (!res) return NextResponse.json({ error: 'user-data service unavailable' }, { status: 502 });
  if (setCookie) {
    res.cookies.set(CID_COOKIE, clientId, { httpOnly: false, maxAge: ONE_YEAR_S, path: '/', sameSite: 'lax' });
  }
  return res;
}
