/**
 * BFF alerts routes — proxies to the gateway (/api/alerts → svc-userdata).
 * GET /api/alerts?unseen=1 → list (optionally unseen only) + unseenCount.
 * POST /api/alerts/seen with {ids: number[]} → mark seen.
 *
 * Same anonymous device identity model as the watchlist routes: `apex_cid`
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

async function proxy(req: NextRequest, gatewayPath: string): Promise<NextResponse> {
  const { clientId, setCookie } = clientIdentity(req);
  const res = await proxyToGateway(req, gatewayPath, { headers: { 'x-client-id': clientId } });
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

export async function GET(req: NextRequest) {
  return proxy(req, '/api/alerts');
}

export async function POST(req: NextRequest) {
  // POST /api/alerts/seen → gateway path /api/alerts/seen (raw URL passthrough).
  return proxy(req, '/api/alerts');
}
