#!/usr/bin/env node
/**
 * api-gateway (port 8080) — the only public entrypoint per ADR-001.
 *
 * - X-Request-Id / X-Trace-Id injection (generates when absent, propagates when given)
 * - Response cache (30s) for GET screener/presets/search
 * - Rate-limit: 100 req/min per IP
 * - Routes via registry /resolve with static SERVICES_JSON fallback
 */
import Fastify from 'fastify';
import { logger, traceCtx, httpClient, loadEnvLocal } from '../shared/lib.mjs';
import { ensurePredictiveInsight } from '../shared/sentimentInsight.mjs';

loadEnvLocal();

const PORT = Number(process.env.PORT || 8080);
const log = logger('api-gateway');
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8010';

const STATIC_SERVICES = process.env.SERVICES_JSON
  ? JSON.parse(process.env.SERVICES_JSON)
  : {
      'market-data': 'http://localhost:8001',
      edgar: 'http://localhost:8002',
      verdict: 'http://localhost:8003',
      news: 'http://localhost:8004',
      llm: 'http://localhost:8005',
      research: 'http://localhost:8006',
      analytics: 'http://localhost:8007',
    };

const app = Fastify({ logger: false, trustProxy: true });

// ---- Rate limit: 100 req/min per IP (fixed window) ----
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;
const buckets = new Map(); // ip -> {count, windowStart}
app.addHook('onRequest', async (req, reply) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > RATE_LIMIT) {
    reply.header('x-ratelimit-limit', RATE_LIMIT);
    reply.header('x-ratelimit-remaining', 0);
    return reply.status(429).send({ error: 'rate limit exceeded (100 req/min per IP)' });
  }
  reply.header('x-ratelimit-limit', RATE_LIMIT);
  reply.header('x-ratelimit-remaining', Math.max(0, RATE_LIMIT - b.count));

  // ---- Trace context injection ----
  const ctx = traceCtx(req);
  req.traceCtx = ctx;
  reply.header('x-request-id', ctx.requestId);
  reply.header('x-trace-id', ctx.traceId);
  req._t0 = process.hrtime.bigint();
});

// Periodic bucket GC so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.windowStart >= RATE_WINDOW_MS) buckets.delete(ip);
}, RATE_WINDOW_MS).unref();

// ---- Request completion logs with status/latency ----
app.addHook('onResponse', async (req, reply) => {
  const ctx = req.traceCtx || {};
  const latencyMs = req._t0 ? Number(process.hrtime.bigint() - req._t0) / 1e6 : undefined;
  log.info({
    requestId: ctx.requestId, traceId: ctx.traceId, span: 'gateway.request',
    msg: `${req.method} ${req.url} -> ${reply.statusCode}`,
    method: req.method, url: req.url, status: reply.statusCode,
    latencyMs: latencyMs !== undefined ? Math.round(latencyMs * 100) / 100 : undefined,
  });
});

app.setErrorHandler((err, req, reply) => {
  log.warn({ requestId: req.traceCtx?.requestId, msg: `${req.method} ${req.url} error: ${err.message}` });
  reply.status(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: err.message });
});

// ---- Service resolution: registry first, static fallback ----
const resolveCache = new Map(); // name -> {url, until}

async function resolveService(name) {
  const cached = resolveCache.get(name);
  if (cached && Date.now() < cached.until) return cached.url;
  try {
    const res = await fetch(`${REGISTRY_URL}/resolve/${name}`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const json = await res.json();
      if (json?.url) {
        resolveCache.set(name, { url: json.url, until: Date.now() + 10_000 });
        return json.url;
      }
    }
  } catch { /* registry down → static fallback */ }
  const fallback = STATIC_SERVICES[name];
  if (!fallback) throw Object.assign(new Error(`unknown service: ${name}`), { statusCode: 502 });
  resolveCache.set(name, { url: fallback, until: Date.now() + 10_000 });
  return fallback;
}

// ---- 30s response cache for whitelisted GETs ----
const CACHE_TTL_MS = 30_000;
const responseCache = new Map(); // cacheKey -> {statusCode, headers, body, expiresAt}

function cacheKeyFor(req) {
  return `${req.method} ${req.url}`;
}

function cacheable(req) {
  if (req.method !== 'GET') return false;
  return req.url.startsWith('/api/screener') || req.url.startsWith('/api/presets') || req.url.startsWith('/api/search');
}

/**
 * Legacy monolith routes are query-param based (`/api/X?symbol=AAPL`), while
 * the services expose path params (`/X/AAPL`). Convert like
 * src/app/api/market-data/route.ts does for the BFF: pull the symbol out of
 * the query, put it in the downstream path, and pass every other query param
 * through verbatim (same raw-URL prefix-replace pattern).
 */
function symbolQueryToPath(url, apiPrefix, basePath, { defaultSymbol = 'NVDA' } = {}) {
  const qIdx = url.indexOf('?');
  const pathPart = url.slice(apiPrefix.length, qIdx >= 0 ? qIdx : undefined);
  const query = qIdx >= 0 ? url.slice(qIdx) : '';
  const params = new URLSearchParams(query);
  // Symbol may arrive as a path segment (/api/financials/AAPL) or as a query
  // param (/api/financials?symbol=AAPL — the legacy monolith shape). Support both.
  let symbol = params.get('symbol') || '';
  if (!symbol && pathPart.startsWith('/') && pathPart.length > 1) {
    symbol = decodeURIComponent(pathPart.slice(1));
  }
  symbol = symbol.trim() || defaultSymbol;
  params.delete('symbol');
  const rest = params.toString();
  return `${basePath}/${encodeURIComponent(symbol)}${rest ? `?${rest}` : ''}`;
}

// Slower downstreams (LLM, multi-service orchestration, backtests) get a
// longer proxy timeout than plain data-plane reads.
function proxyTimeoutFor(url) {
  if (url.includes('/research') || url.includes('/ai-research') || url.includes('/prediction') || url.includes('/verdict') || url.includes('/narrate')) return 90_000;
  if (url.includes('/backtest')) return 75_000;
  if (url.includes('/financials') || url.includes('/technical') || url.includes('/sentiment')) return 40_000;
  return 25_000;
}

// ---- Proxy plumbing ----
app.all('/api/*', async (req, reply) => {
  const key = cacheKeyFor(req);
  if (cacheable(req)) {
    const hit = responseCache.get(key);
    if (hit && Date.now() < hit.expiresAt) {
      reply.header('x-cache', 'HIT');
      return reply.status(hit.statusCode).headers(hit.headers).send(hit.body);
    }
  }

  const url = req.url;
  let serviceName;
  let downstreamPath;
  if (url.startsWith('/api/screener') || url.startsWith('/api/presets') || url.startsWith('/api/search')) {
    serviceName = 'edgar';
    downstreamPath = url.replace(/^\/api/, '');
  } else if (url.startsWith('/api/quote') || url.startsWith('/api/candles') || url.startsWith('/api/indices')) {
    serviceName = 'market-data';
    downstreamPath = url.replace(/^\/api/, '');
  } else if (url.startsWith('/api/news/')) {
    serviceName = 'news';
    downstreamPath = url.replace(/^\/api\/news/, '/drivers');
  } else if (url.startsWith('/api/verdict')) {
    serviceName = 'verdict';
    downstreamPath = url.replace(/^\/api\/verdict/, '/verdict');
  } else if (url.startsWith('/api/llm/')) {
    serviceName = 'llm';
    downstreamPath = url.replace(/^\/api\/llm/, '');
  } else if (url.startsWith('/api/financials')) {
    // research data plane: /api/financials?symbol=X&section=Y → /financials/X?section=Y
    serviceName = 'research';
    downstreamPath = symbolQueryToPath(url, '/api/financials', '/financials');
  } else if (url.startsWith('/api/filings')) {
    serviceName = 'research';
    downstreamPath = symbolQueryToPath(url, '/api/filings', '/filings');
  } else if (url.startsWith('/api/technical')) {
    serviceName = 'research';
    downstreamPath = symbolQueryToPath(url, '/api/technical', '/technical');
  } else if (url.startsWith('/api/sentiment')) {
    // news downstream /sentiment/:symbol (path param, unlike the legacy query param)
    serviceName = 'news';
    downstreamPath = symbolQueryToPath(url, '/api/sentiment', '/sentiment');
  } else if (url.startsWith('/api/prediction')) {
    serviceName = 'analytics';
    downstreamPath = symbolQueryToPath(url, '/api/prediction', '/prediction');
  } else if (url.startsWith('/api/backtest')) {
    // POST passthrough — body and any query string forwarded verbatim
    serviceName = 'analytics';
    downstreamPath = url.replace(/^\/api\/backtest/, '/backtest');
  } else if (url.startsWith('/api/ai-research')) {
    // LLM plane orchestration endpoint
    serviceName = 'llm';
    downstreamPath = url.replace(/^\/api\/ai-research/, '/research');
  } else if (url.startsWith('/api/registry/services')) {
    serviceName = 'svc-registry';
    downstreamPath = url.replace(/^\/api\/registry/, '');
  } else {
    return reply.status(404).send({ error: `no route for ${url}` });
  }

  const base = await resolveService(serviceName);
  // downstreamPath already includes any inbound query string (it's a raw-url
  // prefix replace), so pass it through verbatim — never append twice.
  const target = `${base}${downstreamPath}`;

  const res = await httpClient.fetch(target, {
    method: req.method,
    body: req.method === 'GET' || req.method === 'HEAD' ? null : req.body,
    ctx: req.traceCtx,
    span: `gateway.proxy.${serviceName}`,
    timeoutMs: proxyTimeoutFor(url),
    log,
  });

  // Shape adaptation in the mapping: svc-news /sentiment/:symbol predates the
  // `predictiveInsight` block of the legacy /api/sentiment payload — fill it in
  // here (exact port of sentimentService.generatePredictions) so the response
  // is byte-compatible with the monolith route.
  if (serviceName === 'news' && url.startsWith('/api/sentiment') && res.json && !res.json.error) {
    res.json = ensurePredictiveInsight(res.json);
  }

  if (cacheable(req) && res.ok) {
    // Trim cache below a sane bound (LRU-ish: drop oldest insertion).
    if (responseCache.size >= 200) {
      responseCache.delete(responseCache.keys().next().value);
    }
    responseCache.set(key, {
      statusCode: res.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: res.json ?? res.text,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  reply.header('x-cache', 'MISS');
  reply.header('x-upstream', serviceName);
  return reply.status(res.status).send(res.json ?? res.text);
});

// Health passthroughs for ops convenience.
app.get('/healthz', async () => ({ ok: true, service: 'api-gateway', ts: Date.now() }));

app.get('/readyz', async () => {
  const upstreams = {};
  for (const name of Object.keys(STATIC_SERVICES)) {
    try {
      const base = await resolveService(name);
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
      upstreams[name] = r.ok ? 'up' : 'down';
    } catch {
      upstreams[name] = 'unreachable';
    }
  }
  return { ok: true, service: 'api-gateway', upstreams };
});

await app.listen({ port: PORT, host: process.env.SERVICE_BIND || '127.0.0.1' });
log.info({ msg: `api-gateway listening on :${PORT}`, port: PORT });

const shutdown = async () => { await app.close(); log.info({ msg: 'api-gateway shut down' }); process.exit(0); };
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
