/**
 * BFF pinned-analyses routes — proxies to the gateway (/api/pins → svc-userdata).
 * Same `apex_cid` cookie identity as watchlist/alerts.
 *
 * GET    /api/pins            → list pins for this device
 * POST   /api/pins {symbol, analysis} → pin an analysis snapshot ("I'm holding")
 * DELETE /api/pins?symbol=X   → unpin
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

async function proxy(req: NextRequest, gatewayPath: string, methodOverride?: 'GET' | 'POST' | 'DELETE'): Promise<NextResponse> {
  const { clientId, setCookie } = clientIdentity(req);
  const res = await proxyToGateway(req, gatewayPath, { headers: { 'x-client-id': clientId } });
  if (!res) return NextResponse.json({ error: 'user-data service unavailable' }, { status: 502 });
  if (setCookie) {
    res.cookies.set(CID_COOKIE, clientId, { httpOnly: false, maxAge: ONE_YEAR_S, path: '/', sameSite: 'lax' });
  }
  return res;
}

export async function GET(req: NextRequest) {
  return proxy(req, '/api/pins');
}

export async function POST(req: NextRequest) {
  return proxy(req, '/api/pins');
}

export async function DELETE(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase();
  if (symbol) return proxy(req, `/api/pins/${encodeURIComponent(symbol)}`);
  return proxy(req, '/api/pins');
}
