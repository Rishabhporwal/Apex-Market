# Tradexa — Microservices Architecture (ADR-001)

Status: APPROVED · Author: Solution Architect · Date: 2026-10-18

## Context
Single Next.js monolith: UI + API routes + services (market data, EDGAR warehouse,
verdict engine, LLM narratives) in one process. Works, but data-plane calls
(quotes/candles/news) and compute-plane calls (verdicts) have wildly different
scaling profiles, failure modes, and deploy cadences.

## Architect's honest assessment (recorded so we don't relitigate)
Microservices for a solo-dev product is usually premature. We adopt a **pragmatic
service architecture**: real network-separated services with independent ports,
discovery, tracing, and per-service caching — but only along seams that actually
need isolation (data plane vs compute plane vs LLM plane). We do NOT fragment
into 15 nano-services; that buys operational debt, not scale.

## Services (each: own process, own port, own repo folder, independently runnable)

| Service | Port | Owns | Backing store | Scaling profile |
|---|---|---|---|---|
| **api-gateway** | 8080 | Routing, auth (later), rate-limit, request-id injection, aggregation, response cache | in-memory LRU | horizontal, stateless |
| **svc-market-data** | 8001 | Quotes, candles, indices; Yahoo integration + TTL cache + stale-on-error | prices.duckdb (RO) + memory | I/O bound; many replicas |
| **svc-edgar** | 8002 | Screener queries, fundamentals, company search; ONLY writer to warehouse | warehouse.duckdb (single writer!) | 1 writer + N readers |
| **svc-verdict** | 8003 | Verdict engine: quant core, levels, strategy, backtest endpoints | stateless (calls 8001/8002/8004) | CPU bound; horizontal |
| **svc-news** | 8004 | News fetch + sentiment scoring + driver bullets | memory TTL | I/O bound |
| **svc-llm** | 8005 | OpenRouter narratives, model routing, prompt templates, cost tracking | memory (cost counters) | I/O bound; low replicas |
| **svc-research** | 8006 | Financials, SEC filings, technical indicators (Yahoo-bound) | memory TTL | I/O bound |
| **svc-analytics** | 8007 | Prediction heuristics, strategy backtests | memory | CPU bound |
| **svc-registry** | 8010 | Service discovery: register/heartbeat/resolve + health dashboard | in-memory | 1 instance (or static fallback) |
| **web (Next.js)** | 3000 | UI only; becomes a pure BFF — all data via gateway | none | Vercel-style |

## Communication decisions
- **Sync: REST/JSON over HTTP** for everything in Phase 1. Reasons: debuggable with curl,
  zero new infra, Fastify handles 10k+ rps. gRPC adds codegen friction we don't need yet.
- **Events (Phase 2):** NATS or Redis Streams for async flows: `verdict.generated`,
  `prices.refreshed`, `filing.ingested`. Consumers: analytics, alerts, cache invalidation.
  Not needed until watchlists/alerts exist — recorded, not built.
- **Rule:** services never call each other's databases. Ever. Data ownership is the boundary.

## Service discovery
- `svc-registry` (8010): `POST /register {name, host, port, healthPath}` → services heartbeat
  every 15s; entries expire after 45s. Gateway resolves `svc://name` → `http://host:port`.
- Fallback: `SERVICES_JSON` env for static bootstrap (docker-compose sets it) — registry
  outage degrades to config, never to downtime.

## Tracing & observability (day-one requirement)
- Every inbound request gets `X-Request-Id` (gateway generates if absent) and
  `X-Trace-Id`; propagated via headers to every downstream call.
- Structured JSON logs (`pino`): `{ts, level, service, requestId, traceId, span, msg, ...ctx}`.
- Every service exposes `/healthz` (liveness) and `/readyz` (readiness + deps).
- Gateway emits request completion logs with status/latency → greppable per-request timeline.
- OpenTelemetry SDK is interface-compatible (our `traceContext` helpers map 1:1) — we can
  switch to real OTLP export later without touching call sites.

## Caching strategy (layered)
1. Gateway: short-TTL response cache for GET screener/presets (30–60s).
2. Service-level: existing `TtlCache` per service (quotes 60s, candles 10m, news 10m).
3. Cross-process (Phase 2, when >1 replica): Redis; interface already isolated behind cacheService.

## Deployment
- Phase 1 (now): each service = `services/<name>/` folder, `npm start` on its port, one machine.
- Phase 2: `docker-compose.yml` — one container per service, healthcheck-gated ordering.
- Phase 3: k8s manifests (readiness probes map 1:1 to /readyz), HPA on svc-market-data/svc-verdict.

## Migration plan (safe, incremental)
1. Scaffold services/ + shared lib (logger, trace, http client, cache) ← **this commit**
2. Extract svc-market-data & svc-edgar; gateway proxies; Next.js BFF switches base URL.
3. Extract svc-verdict (calls 8001/8002/8004 internally); svc-news; svc-llm.
4. E2E trace verification: one UI click → one traceId across 5 services in logs.
5. docker-compose + README runbook.
The Next.js app keeps working at every step (feature-flagged base URLs), so we can
pause between any two steps.

## Non-goals (explicit)
No k8s yet, no gRPC yet, no message bus yet, no multi-region, no service mesh.
Each unlocked by real need, not resume-driven development.
