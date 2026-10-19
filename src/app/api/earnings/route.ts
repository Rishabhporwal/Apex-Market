import { NextRequest, NextResponse } from 'next/server';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

// GET /api/earnings?symbol=AAPL → svc-research GET /earnings/AAPL
// Next earnings date + days-until (earnings-calendar awareness for verdicts)
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ error: 'Missing required query parameter: symbol' }, { status: 400 });
  }
  const res = await proxyToGateway(req, `/api/earnings/${encodeURIComponent(symbol)}`);
  if (res) return res;

  // Gateway not configured: no local implementation (lives in svc-research).
  return NextResponse.json({ error: 'research service unavailable' }, { status: 502 });
}
