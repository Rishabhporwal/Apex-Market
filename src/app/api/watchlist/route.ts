/**
 * BFF watchlist routes — proxies to the gateway (/api/watchlist → svc-userdata).
 *
 * Identity: an `x-client-id` header is required by svc-userdata. The client id
 * comes from the `apex_cid` cookie; when absent a fresh UUID is generated and
 * set back as a cookie (httpOnly=false, 1 year) so the device keeps its
 * watchlist. This is anonymous device identity, NOT auth (see svc-userdata).
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
  if (!res) {
    // Gateway not configured / unreachable: no local implementation exists for
    // user state — the service is the only source of truth.
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

export async function GET(req: NextRequest) {
  return proxy(req, '/api/watchlist');
}

export async function POST(req: NextRequest) {
  return proxy(req, '/api/watchlist');
}

export async function DELETE(req: NextRequest) {
  // svc-userdata exposes DELETE /watchlist/:symbol (path param). The UI calls
  // DELETE /api/watchlist?symbol=X (query style), so rewrite to the path form.
  // proxyToGateway appends the inbound query string too, but Fastify ignores
  // unknown query params on a :symbol route.
  const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase();
  if (symbol) {
    return proxy(req, `/api/watchlist/${encodeURIComponent(symbol)}`);
  }
  return proxy(req, '/api/watchlist');
}
