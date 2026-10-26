# ApexMarket AI

Institutional-grade stock research platform — AI-first, open-source, runs entirely on public data.

**What it does:** fuses SEC EDGAR fundamentals (10,400+ companies), technical indicators, and news sentiment into a deterministic BUY/SELL/HOLD verdict with price targets, stop-loss, support/resistance clusters, entry zones, and a plain-English strategy plan — then layers an LLM narrative on top.

## Why it's different

- **Verdicts you can audit.** Every verdict shows its inputs: the quant score breakdown, the news that moved it, the filings behind the fundamentals, and the exact support/resistance math.
- **Backtested honestly.** The verdict engine's quant core is replayed over history with strict no-look-ahead rules (see `npm run backtest`). No fantasy numbers — reported as measured, including where it merely matches the benchmark.
- **Runs with zero API keys.** SEC EDGAR is public domain; the deterministic engine works without any LLM. Add an OpenRouter key and the narrative layer activates.
- **Real microservices, not a demo.** 9 services with discovery, tracing (one request-id across every hop), layered caching, and a gateway — but the monolith still runs standalone with one command.

## Quick start (monolith mode)

```bash
npm install
npm run ingest:edgar        # ~5 min, S&P 500 into DuckDB
npm run dev                 # http://localhost:3000
```

Optional: `echo "OPENROUTER_API_KEY=..." > .env.local` for AI narratives.
Optional: `npm run refresh:prices` daily (see README-DATA.md for launchd scheduling).

## Microservices mode (Docker)

```bash
docker compose up -d --build   # gateway :8080, web :3000, 7 internal services
docker compose ps              # health matrix
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design decisions, service topology, and what we deliberately did *not* build.

## The verdict pipeline

1. **Data** — SEC EDGAR XBRL facts → DuckDB warehouse (ingest script, idempotent)
2. **Quant core** — trend alignment (±25), RSI position (±15), news sentiment (±25), fundamentals (±35) → score −100..100
3. **Discipline** — BUY requires score ≥ 35; SELL requires ≥2 independent bearish confirmations (trend + deteriorating fundamentals or momentum exhaustion)
4. **Levels** — fractal pivots, ATR-depth entry zones (≥1 ATR), stop/targets from structure
5. **Narrative** — LLM (default DeepSeek V3.2 via OpenRouter, ~$0.001/verdict) turns the numbers into institutional prose; deterministic fallback if no key

## Repository map

```
src/            Next.js 16 UI + BFF (App Router, React 19, Tailwind)
services/       The 9-service mesh (plain Node ESM, Fastify, pino)
scripts/        EDGAR ingest, price refresh, verdict backtester
docker/         Shared service Dockerfile + web Dockerfile
data/           warehouse.duckdb (gitignored), prices, reports
```

## Status

- [x] EDGAR warehouse + screener (10k companies)
- [x] AI verdict engine with levels/targets/stops + strategy plan
- [x] 9-service mesh with tracing + docker compose
- [x] Verdict backtester with honest methodology
- [x] Watchlists + verdict-change alerts (svc-userdata, per-device)
- [x] Multi-model ensemble voting + score-evolution chart
- [x] Filing Q&A — grounded answers from actual 10-K/10-Q text with `[n]` citations (svc-research retrieval → svc-llm grounded prompt; disk-cached filings)
- [x] Persistent paper portfolio (per-device SQLite state, survives restarts)
- [x] Verdict drill-down — "Why this verdict?" panel with per-component receipts
- [x] Earnings-calendar awareness — caution banner + watchlist badges near report dates

## License & data

Code: MIT (see LICENSE). Market data: SEC EDGAR (public domain) + Yahoo Finance for live quotes (respect their ToS — this is for personal/research use). LLM narratives: your own OpenRouter key, your own spend.
