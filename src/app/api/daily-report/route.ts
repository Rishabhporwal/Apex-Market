import { NextRequest, NextResponse } from 'next/server';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

// Daily Top-15 research report (svc-verdict owns the run + storage).
// GET  /api/daily-report     → latest report (today's or most recent)
// POST /api/daily-report?run=1 → manual "Run now"
export async function GET(req: NextRequest) {
  const proxied = await proxyToGateway(req, '/api/daily-report');
  if (proxied) return proxied;
  return NextResponse.json({ error: 'daily-report requires the microservices mesh (API_GATEWAY_URL)' }, { status: 502 });
}

export async function POST(req: NextRequest) {
  const proxied = await proxyToGateway(req, '/api/daily-report/run');
  if (proxied) return proxied;
  return NextResponse.json({ error: 'daily-report requires the microservices mesh (API_GATEWAY_URL)' }, { status: 502 });
}
