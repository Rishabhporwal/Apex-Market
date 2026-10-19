# Data Layer

## Files
- `data/warehouse.duckdb` — SEC EDGAR XBRL facts (companies, facts, metrics_latest). Written ONLY by `scripts/ingest-edgar.mjs`. Re-ingest rarely (fundamentals change quarterly at most).
- `data/prices.duckdb` — daily live quotes from Yahoo. Written ONLY by `scripts/refresh-prices.mjs`. Separate file so price refreshes never conflict with the read-only warehouse the dev server holds open.
- `data/latest-prices.json` — flat snapshot of the latest quotes for cheap API-layer reads.

## Commands
```bash
npm run ingest:edgar        # S&P 500 fundamentals (~5 min)
npm run ingest:edgar:all    # full SEC universe ~10k (~2h)
npm run refresh:prices      # daily price refresh (~30s per 1000 tickers)
npm run backtest            # verdict-engine backtest → data/backtest-report.json
```

## Scheduling (macOS launchd)
```bash
cp scripts/com.researchplatform.refresh-prices.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.researchplatform.refresh-prices.plist   # runs daily 08:00
launchctl list | grep researchplatform   # verify
```

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
