import { NextRequest, NextResponse } from 'next/server';
import { proxyToGateway } from '@/services/gatewayProxy';

export const runtime = 'nodejs';

// POST /api/filing-qa {symbol, question} → svc-llm POST /filing-qa
// Grounded Q&A over the company's actual SEC filing text with citations.
export async function POST(req: NextRequest) {
  const proxied = await proxyToGateway(req, '/api/filing-qa');
  if (proxied) return proxied;

  // Gateway not configured: no local implementation (retrieval lives in svc-research).
  return NextResponse.json({ error: 'filing-qa requires the microservices mesh (API_GATEWAY_URL)' }, { status: 502 });
}
