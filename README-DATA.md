# Data Layer

## Files
- `data/warehouse.duckdb` — SEC EDGAR XBRL facts (companies, facts, metrics_latest). Written ONLY by `scripts/ingest-edgar.mjs`. Re-ingest rarely (fundamentals change quarterly at most).
- `data/warehouse.duckdb` quarterly tables — `facts_quarterly` (10-Q facts, last ~10 years / ~40 quarters) and `metrics_ttm` (rolling-TTM growth/quality metrics). Written ONLY by `scripts/ingest-edgar-quarterly.mjs`. Run quarterly (after the bulk of 10-Qs land: ~6 weeks after each calendar quarter end).
- `data/prices.duckdb` — daily live quotes from Yahoo. Written ONLY by `scripts/refresh-prices.mjs`. Separate file so price refreshes never conflict with the read-only warehouse the dev server holds open.
- `data/latest-prices.json` — flat snapshot of the latest quotes for cheap API-layer reads.

## Quarterly (10-Q) data and TTM metrics
`scripts/ingest-edgar-quarterly.mjs` ingests the sector-labeled index universe
(S&P 500 + S&P 400, ~900 names) into TWO new tables:

- **`facts_quarterly`** — same shape as `facts`, but ONLY quarterly facts:
  `fp ∈ Q1..Q4`, form `10-Q`/`10-Q/A`, duration 55–130 days (YTD stubs
  excluded), period ends within the last ~10 years (120 months).
  It is a separate table, NOT a `period` column on `facts`, because
  svc-edgar's screener revenue CTE reads `facts` unfiltered and identifies
  annual pairs by a 300–400-day gap between period ends — quarterly rows
  would poison that. Keep it separate; existing consumers are untouched.
- **`metrics_ttm`** — rolling-TTM metrics computed AT INGEST TIME (not at
  query time; deterministic, no windowing SQL): for each company the 4 most
  recent consecutive fiscal quarters (gaps 80–100 days) give
  `revenue_ttm`, `net_income_ttm`, `net_margin_ttm`; the prior 4 quarters
  give `revenue_ttm_prior` → `revenue_growth_ttm` (null until 8 quarters
  exist). `filed_at` = the filing date that completed the TTM window
  (look-ahead-safe). Standalone Q4 values never appear in 10-Qs, so Q4 is
  derived as FY (10-K, ≥300d) − 9-month YTD (10-Q, 150–400d) and carries
  `filed_at` = max(10-K filed, YTD filed). Restatements: latest-filed value
  per period end wins.

Commands:
```bash
npm run ingest:edgar:quarterly          # S&P 500 + S&P 400 (~900 names, ~15 min)
npm run ingest:edgar:quarterly -- --sp500   # or --sp400 for a single index
```
Errors land in `data/ingest-quarterly-errors.log`. Foreign private issuers
(40-F/20-F filers, e.g. Suncor) file no 10-Qs and are logged as noFacts —
expected.

## Commands
```bash
npm run ingest:edgar        # S&P 500 fundamentals (~5 min)
npm run ingest:edgar:all    # full SEC universe ~10k (~2h)
npm run ingest:edgar:quarterly  # S&P 500 + S&P 400 quarterly 10-Q + TTM (~15 min)
npm run refresh:prices      # full warehouse price refresh (~7k tickers, ~90 min)
npm run refresh:prices:index   # FAST: S&P 500 + S&P 400 only (~903 tickers, ~15 min)
npm run backtest            # verdict-engine backtest → data/backtest-report.json
```

`--index-universe` reads the constituent lists directly (S&P 500 CSV + the
Wikipedia S&P 400 table — same sources as `ingest-edgar.mjs`; no warehouse
snapshot needed) and MERGES the refreshed quotes into
`data/latest-prices.json` so non-index tickers keep their last-known prices.

## Scheduling (macOS launchd — pre-market price refresh)
The daily analysis (svc-verdict `scheduleDailyReport`) runs at 08:30 ET, so
live prices must be fresh before that. `com.tradexa.refresh-prices` ticks
every 30 minutes and `scripts/scheduled-refresh.mjs` decides whether a tick
is useful:

- ET (America/New_York, DST-safe) weekday time must be inside **07:25–08:10**.
- Skips if `data/.last-price-refresh` (ET date string) already == today.
- Runs `node scripts/refresh-prices.mjs --index-universe` (~15 min, finishes
  well before the 08:30 analysis), stamps the state file on success, and
  appends timestamped output to `data/refresh-cron.log`.
- A `data/.refresh-lock` (stale > 30 min is broken) prevents overlapping runs
  when a tick fires mid-refresh.

Sleep/DST robustness: a calendar job missed during sleep is lost forever, but
launchd fires ONE missed `StartInterval` tick on wake — the guard then runs it
if the window is still open. A fully missed window = skipped day; the next
weekday retries. No fixed wall-clock hour is baked into launchd itself.

Install:
```bash
cp scripts/com.tradexa.refresh-prices.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.tradexa.refresh-prices.plist
launchctl list | grep tradexa   # verify: PID + last exit status
tail -f data/refresh-cron.log   # watch the next 07:25–08:10 ET window
```
svc-verdict's `scheduleDailyReport` carries the same guard as a secondary
(best-effort): if prices were not refreshed today when the 08:30 run fires, it
runs the fast refresh first (20-min budget) — but inside Docker the service
image has no `scripts/`, so the host launchd job is the primary refresher.

## Lock etiquette (DuckDB = one writer per file)
- The dev server / API opens the warehouse READ_ONLY. Never write to it from a request path.
- Write paths (ingest, refresh) use their own files; refresh reads the warehouse via a short-lived file snapshot copy.
- If a `.wal` file lingers after a crash, open once read-write and `CHECKPOINT;`.

## Backtest methodology (honest numbers)
`scripts/backtest-verdicts.mjs` replays the verdict engine's quant core over history:
- Monthly checkpoints per ticker; each checkpoint sees ONLY data before it (no look-ahead).
- Fundamentals come from the latest 10-K filed before the checkpoint date.
- News/LLM are excluded from scoring (no historical news feed exists) — results are a lower bound on live performance.
- Forward returns are measured over `--horizon` days (default 90) vs SPY over identical windows.
