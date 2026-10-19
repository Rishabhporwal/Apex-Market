import { NextRequest, NextResponse } from 'next/server';
import { proxyToGateway } from '@/services/gatewayProxy';

const CID_COOKIE = 'apex_cid';
const ONE_YEAR_S = 60 * 60 * 24 * 365;

function clientIdentity(req: NextRequest): { clientId: string; setCookie: boolean } {
  const existing = req.cookies.get(CID_COOKIE)?.value;
  if (existing) return { clientId: existing, setCookie: false };
  return { clientId: crypto.randomUUID(), setCookie: true };
}

// POST /api/watchlist/check-now → svc-userdata POST /watchlist/check-now
// (triggers an immediate verdict re-check for alert generation; normally runs every 5 min)
export async function POST(req: NextRequest) {
  const { clientId, setCookie } = clientIdentity(req);
  const res = await proxyToGateway(req, '/api/watchlist/check-now', { headers: { 'x-client-id': clientId } });
  if (!res) return NextResponse.json({ error: 'user-data service unavailable' }, { status: 502 });
  if (setCookie) {
    res.cookies.set(CID_COOKIE, clientId, { httpOnly: false, maxAge: ONE_YEAR_S, path: '/', sameSite: 'lax' });
  }
  return res;
}
