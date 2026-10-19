# ApexMarket Phase-1 Services (ADR-001)

Network-separated microservices extracted from the Next.js monolith. Plain
Node.js ESM (.mjs) + Fastify + pino — no TS build step. Each service runs
standalone: `node services/<name>/index.mjs` or `npm run svc:<name>`.

| Service | Port | Owns |
|---|---|---|
| svc-registry | 8010 | discovery: /register, /heartbeat, /resolve/:name, /services (45s expiry) |
| svc-market-data | 8001 | /quote/:symbol, /candles/:symbol, /indices (Yahoo + TTL caches) |
| svc-edgar | 8002 | /screener, /search?q=, /company/:ticker (warehouse.duckdb READ_ONLY + latest-prices.json) |
| svc-verdict | 8003 | POST/GET /verdict — orchestrates 8001/8002/8004/8005, quant core + levels |
| svc-news | 8004 | /drivers/:symbol, /sentiment/:symbol (keyword sentiment, 10min TTL) |
| svc-llm | 8005 | POST /narrate (OpenRouter), GET /stats (cost counters) |
| api-gateway | 8080 | /api/* routing, 30s GET cache, 100 req/min rate-limit, trace injection |

## Run

```bash
npm run svc:start     # all seven, colored prefix logs (pids in services/.run/)
npm run svc:stop      # stop them all
npm run svc:market-data   # any service individually
```

## Conventions

- **Tracing:** gateway injects `X-Request-Id` + `X-Trace-Id`; `traceCtx(req)`
  (services/shared/lib.mjs) propagates them to every downstream call. Every
  service logs request completion with `{service, requestId, traceId, status, latencyMs}`.
- **Caching:** shared `TtlCache` — quotes 60s, candles 10min, news 10min,
  stale-on-error + single-flight (port of src/services/cacheService.ts).
- **Discovery:** services self-register with the registry and heartbeat every
  15s; entries expire after 45s. Gateway falls back to static
  `SERVICES_JSON` (or built-in defaults) when the registry is down.
- **Health:** `/healthz` (liveness) + `/readyz` (readiness + deps) everywhere.
- **Env:** services load `.env.local` at boot (OPENROUTER_API_KEY for svc-llm).
  Keys are never logged.

## Phase-1 boundary

The Next.js app (src/) is untouched this phase and keeps serving from its own
in-process services. The BFF switch (UI → gateway) happens in step 2 of the
migration plan (ARCHITECTURE.md).
