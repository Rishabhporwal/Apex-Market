/**
 * BFF→gateway bridge.
 *
 * When API_GATEWAY_URL is configured (e.g. http://localhost:8080 with the
 * docker-compose stack up), API route handlers proxy the request to the
 * microservices gateway instead of running the in-process implementation.
 * When unset, everything behaves exactly like the pre-mesh monolith — so the
 * open-source one-command local setup keeps working with zero services.
 *
 * Usage at the top of a route handler:
 *   const proxied = await proxyToGateway(req, '/api/screener');
 *   if (proxied) return proxied;
 *   // ...local implementation unchanged...
 */
import { NextRequest, NextResponse } from 'next/server';

export function gatewayConfigured(): boolean {
  return Boolean(process.env.API_GATEWAY_URL);
}

export interface ProxyOptions {
  /** Extra headers forwarded verbatim to the gateway (e.g. x-client-id). */
  headers?: Record<string, string>;
}

/**
 * Forward the request to the gateway. Returns null when the gateway is not
 * configured (caller falls through to the local implementation).
 */
export async function proxyToGateway(req: NextRequest, gatewayPath: string, options: ProxyOptions = {}): Promise<NextResponse | null> {
  const base = process.env.API_GATEWAY_URL;
  if (!base) return null;

  const url = new URL(req.url);
  const target = `${base.replace(/\/$/, '')}${gatewayPath}${url.search}`;

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.headers || {}) };
    // Propagate inbound trace headers so gateway→mesh logs chain from the web app
    for (const h of ['x-request-id', 'x-trace-id']) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }

    const init: RequestInit = { method: req.method, headers, signal: AbortSignal.timeout(90_000) };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.text();
    }

    const res = await fetch(target, init);
    const body = await res.text();
    const out = new NextResponse(body, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') || 'application/json',
        'x-served-by': 'gateway',
      },
    });
    return out;
  } catch (err: any) {
    console.warn(`[gatewayProxy] ${gatewayPath} via gateway failed (${err?.message}) — falling back to local`);
    return null; // degrade to in-process on gateway failure
  }
}
