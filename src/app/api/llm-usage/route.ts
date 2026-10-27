/**
 * BFF LLM cost/token ledger route — proxies to the gateway (/api/llm-usage →
 * svc-llm GET /usage). Read-only; no client identity needed (usage is global,
 * not per-device). Query passthrough: ?days=N&symbol=X.
 */
import { NextRequest, NextResponse } from 'next/server';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const proxied = await proxyToGateway(req, '/api/llm-usage');
  if (proxied) return proxied;
  return NextResponse.json({ error: 'gateway not configured' }, { status: 502 });
}
