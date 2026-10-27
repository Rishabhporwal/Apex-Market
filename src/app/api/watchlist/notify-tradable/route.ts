/**
 * BFF route — 'Notify me when tradable' toggle.
 * POST /api/watchlist/notify-tradable {symbol, enabled} → svc-userdata
 * /watchlist/notify-tradable via the gateway (prefix route already maps
 * /api/watchlist/* → /watchlist/*). Returns the refreshed watchlist shape.
 *
 * Same anonymous device identity model as the other userdata routes: `apex_cid`
 * cookie (or a freshly generated one) forwarded as `x-client-id`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { proxyToGateway } from '@/services/gatewayProxy';

const CID_COOKIE = 'apex_cid';
const ONE_YEAR_S = 60 * 60 * 24 * 365;

function clientIdentity(req: NextRequest): { clientId: string; setCookie: boolean } {
  const existing = req.cookies.get(CID_COOKIE)?.value;
  if (existing) return { clientId: existing, setCookie: false };
  return { clientId: crypto.randomUUID(), setCookie: true };
}

export async function POST(req: NextRequest) {
  const { clientId, setCookie } = clientIdentity(req);
  const res = await proxyToGateway(req, '/api/watchlist/notify-tradable', { headers: { 'x-client-id': clientId } });
  if (!res) {
    return NextResponse.json({ error: 'user-data service unavailable' }, { status: 502 });
  }
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
