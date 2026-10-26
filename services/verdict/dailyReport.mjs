/**
 * Daily Top-15 research run (svc-verdict).
 *
 * Product contract:
 *  - A weekly-refreshed universe of the 15 highest-quality companies (SEC EDGAR
 *    fundamentals: revenue growth, net margin, ROE, sane P/E) — refreshed like
 *    an index, not churned daily, so day-over-day comparisons stay meaningful.
 *  - Once per weekday at 08:30 America/New_York (1 hour before the 9:30 open,
 *    DST-safe), each symbol gets a FULL verdict (news + cached narrative).
 *    This pre-warms the research cache — the UI's first view of each name is
 *    instant and free.
 *  - Results are ranked best-first and stored as data/daily-runs/YYYY-MM-DD.json.
 *  - After the run, a summary is pushed to DAILY_REPORT_WEBHOOK_URL (falls back
 *    to ALERT_WEBHOOK_URL) when configured.
 *
 * All fetches degrade independently: a symbol that fails is recorded with an
 * error note, never aborts the run.
 */
import fs from 'node:fs';
import path from 'node:path';

const DAILY_DIR = path.join(process.env.DATA_DIR || '/app/data', 'daily-runs');
const UNIVERSE_SIZE = 5;
// Capital-fit guard: the report targets small accounts — only names whose
// share price keeps a single share (and a sensible position) within reach.
const MAX_SHARE_PRICE = 400;
// Investable-universe hygiene (the fundamentals screen otherwise lets derivative
// share classes and pennies through): no sub-$5 stocks, no warrants/units/
// rights (NASDAQ 5-letter suffix convention), no preferred classes (dash), and
// no derivative-named instruments (live quote names like "… Warrants",
// "… Units", "… Notes", "Preferred Stock" — SEC's ticker map includes these,
// so the name is the only reliable signal).
const MIN_SHARE_PRICE = 5;
const DERIVATIVE_TICKER_RE = /(^[A-Z]{4,}[WUR]$)|-/;
const DERIVATIVE_NAME_RE = /\b(warrant|unit|right|note|debenture|preferred|preference|depositary|subscription)\b/i;
const UNIVERSE_REFRESH_DAYS = 7;
const RUN_HOUR_ET = 8; // 08:30 ET = 1 hour before the 9:30 open
const RUN_MINUTE_ET = 30;

let deps = null; // { resolveService, httpClient, log, generateVerdict, appLog }

export function initDailyReport(d) {
  deps = d;
}

// ---- Quality score (explainable, deterministic) ----------------------------
// 0–100 composite: growth 35 · margin 25 · ROE 25 · valuation sanity 15.
// Caps keep single-dimension outliers (e.g. 800% growth) from dominating.
export function qualityScore(m) {
  const growth = Math.max(0, Math.min(40, m.revenueGrowthYoY ?? 0)) / 40 * 35;
  const margin = Math.max(0, Math.min(40, m.netMargin ?? 0)) / 40 * 25;
  const roe = Math.max(0, Math.min(60, m.roe ?? 0)) / 60 * 25;
  const pe = m.peRatio;
  const pePts = pe === undefined || pe === null ? 0 : pe <= 0 ? 0 : pe <= 25 ? 15 : pe <= 60 ? 8 : 0;
  return Math.round((growth + margin + roe + pePts) * 10) / 10;
}

// ---- Universe ---------------------------------------------------------------
function currentWeekTag(now = new Date()) {
  // ISO-8601 week number (weeks start Monday)
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function qualityRanked(ctx) {
  const { resolveService, httpClient, appLog } = deps;
  const base = await resolveService('edgar', ctx);
  // Quality screen mirrors the platform's 'quality' preset (growth 10%+,
  // margin 10%+, ROE 12%+). Ranking uses fundamentals only; price filters are
  // applied later via LIVE quotes (the latest-prices.json snapshot is stale).
  const res = await httpClient.fetch(
    `${base}/screener?minRevenueGrowth=10&minNetMargin=10&minRoe=12&limit=150`,
    { ctx, span: 'verdict.daily.universe', timeoutMs: 60_000, log: appLog }
  );
  // One entry per CIK: derivative share classes (notes/warrants/preferreds)
  // inherit the issuer's fundamentals, so the screen can't reject them. Two
  // layers:
  //  1. CIK dedup — keep the shortest ticker per CIK (the primary common
  //     class, e.g. FTAI over FTAIM) when both appear in the screen.
  //  2. Sibling check — a candidate whose CIK has a SHORTER mapped ticker
  //     (even when that sibling isn't in the screen, e.g. FTAI not ingested)
  //     is itself a derivative class; reject it. SEC's ticker map is the
  //     authority (same file svc-research caches for filing-context).
  const rows0 = res.json?.results || [];
  if (!rows0.length) throw new Error('quality screen returned no companies — is the EDGAR warehouse populated?');
  let tickerToCik = new Map();
  let cikToTickers = new Map();
  try {
    const map = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'Research Platform <admin@researchplatform.dev>' },
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json());
    for (const v of Object.values(map)) {
      const t = String(v.ticker).toUpperCase();
      tickerToCik.set(t, v.cik_str);
      if (!cikToTickers.has(v.cik_str)) cikToTickers.set(v.cik_str, []);
      cikToTickers.get(v.cik_str).push(t);
    }
  } catch (err) {
    appLog.warn({ span: 'verdict.daily', msg: `ticker map fetch failed (${err.message}) — CIK dedup disabled this run` });
  }
  const byCik = new Map();
  for (const r of rows0) {
    const cik = tickerToCik.get(r.symbol);
    const key = cik != null ? `cik:${cik}` : `sym:${r.symbol}`;
    const prev = byCik.get(key);
    if (!prev || r.symbol.length < prev.symbol.length) byCik.set(key, r);
  }
  const deduped = [...byCik.values()].filter((r) => {
    const cik = tickerToCik.get(r.symbol);
    if (cik == null) return true;
    const siblings = cikToTickers.get(cik) || [];
    // primary = shortest ticker for the CIK; reject anything longer
    const primary = siblings.reduce((a, b) => (b.length < a.length ? b : a), r.symbol);
    if (r.symbol !== primary) {
      appLog.info({ span: 'verdict.daily', msg: `universe dedup: ${r.symbol} is a secondary class of ${primary} (${cik}), rejected` });
      return false;
    }
    return true;
  });
  appLog.info({ span: 'verdict.daily', msg: `universe dedup: ${rows0.length} rows -> ${deduped.length} unique issuers` });
  return deduped
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      // Sector threads through to the daily-report pool sort (1 name per
      // sector cap). Screener rows always carry it ('Unknown' fallback).
      sector: r.sector ?? null,
      qualityScore: qualityScore(r),
      metrics: {
        revenueGrowthYoY: r.revenueGrowthYoY,
        netMargin: r.netMargin,
        roe: r.roe,
        peRatio: r.peRatio,
        marketCap: r.marketCap,
      },
    }))
    .sort((a, b) => b.qualityScore - a.qualityScore || (b.metrics.marketCap || 0) - (a.metrics.marketCap || 0));
}

// Liquidity floor (selection-hygiene audit): a candidate whose dollar volume
// (quote avgVolume * price) is under $5M is untradable for small accounts —
// spreads and slippage dominate. Skipped during the hygiene walk.
const MIN_DOLLAR_VOLUME_USD = 5_000_000;

/**
 * Hygiene walk: walk a fundamentals-ranked candidate list, fetching each
 * candidate's LIVE quote (price + name), until `count` pass the investable
 * filters (no derivatives by ticker or name, $5 floor, $400 cap, $5M dollar-
 * volume floor). Unpriced candidates are skipped without aborting the walk.
 */
async function hygieneWalk(ranked, count, ctx, exclude = new Set()) { // exported below for tests
  const { resolveService, httpClient, appLog } = deps;
  const mdBase = await resolveService('market-data', ctx).catch(() => null);
  const picked = [];
  const quoteFor = async (symbol) => {
    if (!mdBase) return null;
    try {
      const q = await httpClient.fetch(`${mdBase}/quote/${encodeURIComponent(symbol)}`, { ctx, span: 'verdict.daily.universe.price', timeoutMs: 8_000, log: appLog });
      const p = q.json?.price;
      return p && typeof p === 'number' && p > 0 ? q.json : null;
    } catch {
      return null;
    }
  };
  for (const cand of ranked) {
    if (picked.length >= count) break;
    if (exclude.has(cand.symbol)) continue;
    if (DERIVATIVE_TICKER_RE.test(cand.symbol)) continue; // warrants/units/rights/preferreds
    const q = await quoteFor(cand.symbol);
    if (!q) {
      appLog.warn({ span: 'verdict.daily', msg: `universe walk: no live quote for ${cand.symbol}, skipped` });
      continue;
    }
    if (DERIVATIVE_NAME_RE.test(q.name || '')) {
      appLog.info({ span: 'verdict.daily', msg: `universe walk: ${cand.symbol} rejected (derivative name: "${q.name}")` });
      continue;
    }
    if (q.price < MIN_SHARE_PRICE || q.price >= MAX_SHARE_PRICE) continue; // $5 hygiene floor + $400 capital-fit cap (kept per user preference)
    const dollarVolume = (q.avgVolume || 0) * q.price;
    if (dollarVolume < MIN_DOLLAR_VOLUME_USD) {
      appLog.info({ span: 'verdict.daily', msg: `universe walk: ${cand.symbol} rejected (dollar volume $${Math.round(dollarVolume).toLocaleString()} < $${MIN_DOLLAR_VOLUME_USD.toLocaleString()})` });
      continue;
    }
    cand.metrics.price = q.price;
    cand.metrics.dollarVolume = Math.round(dollarVolume);
    cand.name = q.name || cand.name;
    picked.push(cand);
  }
  if (!picked.length) throw new Error(`no quality companies under $400 passed the hygiene filters — widen the screen or check the price feed`);
  return picked;
}

async function buildUniverse(ctx) {
  const ranked = await qualityRanked(ctx);
  const picked = await hygieneWalk(ranked, UNIVERSE_SIZE, ctx);
  deps.appLog.info({ span: 'verdict.daily', msg: `universe walk: ${picked.length} core names selected` });
  return picked;
}

/**
 * Daily fresh candidates: quality-ranked names NOT in the core universe and
 * NOT analyzed in the last FRESH_DEDUP_DAYS, hygiene-walked like the core.
 * This is the daily discovery stream — stable core for thesis continuity,
 * fresh names for novelty, bounded cost (FRESH_SIZE full analyses/day).
 */
const FRESH_SIZE = 2;
const FRESH_DEDUP_DAYS = 7;

function recentlyAnalyzedSymbols(days = FRESH_DEDUP_DAYS) {
  const cutoff = Date.now() - days * 86_400_000;
  const seen = new Set();
  try {
    for (const f of fs.readdirSync(DAILY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
      const report = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, f), 'utf8'));
      if ((report.completedAt || 0) < cutoff) continue;
      for (const r of report.results || []) seen.add(r.symbol);
      for (const r of report.fresh || []) seen.add(r.symbol);
    }
  } catch { /* first run — nothing recent */ }
  return seen;
}

async function pickFreshCandidates(coreSymbols, ctx) {
  const recent = recentlyAnalyzedSymbols();
  const exclude = new Set([...coreSymbols, ...recent]);
  const ranked = (await qualityRanked(ctx)).filter((c) => !exclude.has(c.symbol));
  const picked = await hygieneWalk(ranked, FRESH_SIZE, ctx);
  deps.appLog.info({ span: 'verdict.daily', msg: `fresh candidates: ${picked.map((s) => s.symbol).join(',') || 'none'} (excluded ${exclude.size} recent/core)` });
  return picked;
}


export { hygieneWalk };

function readUniverse() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DAILY_DIR, 'universe.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function ensureUniverse(ctx, force = false) {
  const existing = readUniverse();
  const tag = currentWeekTag();
  const ageDays = existing ? (Date.now() - existing.builtAt) / 86400000 : Infinity;
  // Migration: universes built before the selection-hygiene audit carry no
  // `sector` on their symbols — rebuild once so the sector cap can engage.
  const hasSectors = existing?.symbols?.length && existing.symbols.every((s) => s.sector !== undefined);
  if (!force && existing && existing.weekTag === tag && ageDays < UNIVERSE_REFRESH_DAYS && hasSectors) return existing;
  const symbols = await buildUniverse(ctx);
  const universe = { weekTag: tag, builtAt: Date.now(), symbols };
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.writeFileSync(path.join(DAILY_DIR, 'universe.json'), JSON.stringify(universe, null, 2));
  deps.appLog.info({ span: 'verdict.daily', msg: `universe rebuilt (${tag}): ${symbols.map((s) => s.symbol).join(',')}` });
  return universe;
}

// ---- The run ----------------------------------------------------------------
let running = false;

export async function runDailyReport(reason = 'manual', ctx = null) {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;
  const startedAt = Date.now();
  try {
    const universe = await ensureUniverse(ctx);
    const { appLog } = deps;
    appLog.info({ span: 'verdict.daily', msg: `daily run started (${reason}) for ${universe.symbols.length} symbols` });

    const results = [];
    for (const u of universe.symbols) {
      try {
        // Full depth: news + LLM narrative (writes the research cache — the
        // daily run IS the cache warmer for the day).
        const v = await deps.generateVerdict(u.symbol, ctx, { depth: 'full' });
        const llmUsage = v.meta?.llmUsage || null;
        results.push({
          symbol: v.symbol,
          name: v.name,
          sector: u.sector ?? null,
          action: v.verdict.action,
          confidence: v.verdict.confidence,
          score: v.breakdown?.score,
          horizon: v.verdict.horizon,
          price: v.price,
          dollarVolume: u.metrics?.dollarVolume ?? null,
          // Computed trade plan (never LLM prose): entry band, stop, R:R, sizing.
          // Geometry audit: a non-tradable plan shows 'no valid plan — wait'
          // instead of buy zone and sizing.
          buyZone: v.tradePlan?.tradable === false
            ? 'no valid plan — wait'
            : v.tradePlan?.entry != null ? `$${v.tradePlan.entry.toFixed(2)} – $${v.tradePlan.entryHigh.toFixed(2)}` : null,
          tradePlan: v.tradePlan
            ? (v.tradePlan.tradable === false ? { ...v.tradePlan, sharesFor1k: 0, maxLossUsd: null } : v.tradePlan)
            : null,
          target1: v.levels?.target1,
          target2: v.levels?.target2,
          stopLoss: v.levels?.stopLoss,
          reason: v.verdict.summary,
          tradeWindow: v.tradeWindow || null,
          earnings: v.earnings || null,
          cachedAnalysis: !!v.meta?.researchCached,
          // Token & cost accounting for this symbol's research (zero when the
          // narrative came from the 24h research cache — that spend happened
          // once, on the run that wrote the cache).
          llm: llmUsage
            ? { promptTokens: llmUsage.totalPromptTokens, completionTokens: llmUsage.totalCompletionTokens, costUsd: llmUsage.totalCostUsd, models: llmUsage.models.map((m) => ({ model: m.model, promptTokens: m.promptTokens, completionTokens: m.completionTokens, costUsd: m.costUsd })) }
            : { promptTokens: 0, completionTokens: 0, costUsd: 0, models: [] },
        });
      } catch (err) {
        results.push({ symbol: u.symbol, name: u.name, error: err.message });
        appLog.warn({ span: 'verdict.daily', msg: `daily run: ${u.symbol} failed: ${err.message}` });
      }
    }

    // ---- Daily fresh candidates (discovery stream) ------------------------
    // Names outside the weekly core that haven't been analyzed in the last
    // FRESH_DEDUP_DAYS — each gets ONE fresh full analysis today (this also
    // warms its research cache, so clicking it later is free all day).
    const freshResults = [];
    try {
      const freshUniverse = await pickFreshCandidates(universe.symbols.map((s) => s.symbol), ctx);
      for (const u of freshUniverse) {
        try {
          const v = await deps.generateVerdict(u.symbol, ctx, { depth: 'full' });
          const llmUsage = v.meta?.llmUsage || null;
          freshResults.push({
            symbol: v.symbol,
            name: v.name,
            sector: u.sector ?? null,
            action: v.verdict.action,
            confidence: v.verdict.confidence,
            score: v.breakdown?.score,
            horizon: v.verdict.horizon,
            price: v.price,
            dollarVolume: u.metrics?.dollarVolume ?? null,
            buyZone: v.tradePlan?.tradable === false
              ? 'no valid plan — wait'
              : v.tradePlan?.entry != null ? `$${v.tradePlan.entry.toFixed(2)} – $${v.tradePlan.entryHigh.toFixed(2)}` : null,
            tradePlan: v.tradePlan
              ? (v.tradePlan.tradable === false ? { ...v.tradePlan, sharesFor1k: 0, maxLossUsd: null } : v.tradePlan)
              : null,
            target1: v.levels?.target1,
            target2: v.levels?.target2,
            stopLoss: v.levels?.stopLoss,
            reason: v.verdict.summary,
            tradeWindow: v.tradeWindow || null,
            earnings: v.earnings || null,
            cachedAnalysis: !!v.meta?.researchCached,
            llm: llmUsage
              ? { promptTokens: llmUsage.totalPromptTokens, completionTokens: llmUsage.totalCompletionTokens, costUsd: llmUsage.totalCostUsd, models: llmUsage.models.map((m) => ({ model: m.model, promptTokens: m.promptTokens, completionTokens: m.completionTokens, costUsd: m.costUsd })) }
              : { promptTokens: 0, completionTokens: 0, costUsd: 0, models: [] },
          });
        } catch (err) {
          freshResults.push({ symbol: u.symbol, name: u.name, error: err.message });
          appLog.warn({ span: 'verdict.daily', msg: `fresh candidate ${u.symbol} failed: ${err.message}` });
        }
      }
      freshResults.sort((a, b) => (b.score ?? b.confidence ?? -999) - (a.score ?? a.confidence ?? -999));
    } catch (err) {
      appLog.warn({ span: 'verdict.daily', msg: `fresh-candidate selection failed: ${err.message}` });
    }

    // ---- One unified list: best 5 of the day across core + fresh ----------
    // Both pools compete on the same score; fresh names can displace core
    // names. The weekly universe remains the candidate GENERATOR (stability
    // for discovery economics), but the list the user reads is merit-ordered.
    // Held positions are protected by pins, not by list membership.
    const succeeded = results.filter((r) => !r.error);
    const freshOk = freshResults.filter((r) => !r.error);
    const freshSymbols = new Set(freshOk.map((r) => r.symbol));
    const pool = [
      ...succeeded.map((r) => ({ ...r, tier: 'core' })),
      ...freshOk.map((r) => ({ ...r, tier: 'fresh' })),
      // Selection-hygiene audit: equal scores tie-break by dollar volume desc.
    ].sort((a, b) =>
      ((b.score ?? b.confidence) - (a.score ?? a.confidence)) ||
      ((b.dollarVolume || 0) - (a.dollarVolume || 0))
    );
    // Selection-hygiene audit: at most ONE name per sector in the displayed
    // list (diversification over score-chasing concentration). null/'Unknown'
    // sectors are each their own bucket — they don't consume a sector slot.
    const seenSectorKeys = new Set();
    const ordered = [];
    for (const r of pool) {
      if (ordered.length >= UNIVERSE_SIZE) break;
      const key = r.sector && r.sector !== 'Unknown' ? `sector:${r.sector}` : `sym:${r.symbol}`;
      if (seenSectorKeys.has(key)) continue;
      seenSectorKeys.add(key);
      ordered.push(r);
    }

    const runUsage = [...results, ...freshResults].reduce(
      (a, r) => ({
        promptTokens: a.promptTokens + (r.llm?.promptTokens || 0),
        completionTokens: a.completionTokens + (r.llm?.completionTokens || 0),
        costUsd: a.costUsd + (r.llm?.costUsd || 0),
      }),
      { promptTokens: 0, completionTokens: 0, costUsd: 0 }
    );
    runUsage.costUsd = Number(runUsage.costUsd.toFixed(6));

    const report = {
      date: new Date().toISOString().slice(0, 10),
      ranAt: startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      universeWeek: universe.weekTag,
      universeBuiltAt: universe.builtAt,
      count: ordered.length,
      // Names analyzed but cut from today's displayed 5 (audit trail; their
      // research caches are warm so clicking them in Watchlist costs nothing).
      analyzed: { core: results.length, fresh: freshResults.length },
      // Whole-run token & cost accounting (sum of per-symbol research).
      llmUsage: runUsage,
      results: ordered,
      // Daily discovery stream: fresh names analyzed today (outside the core).
      fresh: freshResults,
    };
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    fs.writeFileSync(path.join(DAILY_DIR, `${report.date}.json`), JSON.stringify(report, null, 2));
    appLog.info({ span: 'verdict.daily', msg: `daily run done (${reason})`, ok: succeeded.length, failed: results.length - succeeded.length, durationMs: report.durationMs });

    deliverReportWebhook(report);
    return { skipped: false, ...report };
  } finally {
    running = false;
  }
}

function deliverReportWebhook(report) {
  const url = process.env.DAILY_REPORT_WEBHOOK_URL || process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const lines = report.results
    .filter((r) => !r.error)
    .map((r, i) => {
      const zone = r.buyZone ? ` · buy ${r.buyZone}` : '';
      const stop = r.stopLoss != null ? ` · stop $${r.stopLoss.toFixed(2)}` : '';
      return `${i + 1}. ${r.symbol} ${r.action} ${r.confidence}%${zone}${stop} — ${r.reason}`;
    });
  const freshLines = (report.fresh || []).filter((r) => !r.error)
    .map((r) => `\u2728 ${r.symbol} ${r.action} ${r.confidence}%\u2003(new today) — ${r.reason}`);
  const failed = report.results.filter((r) => r.error).length;
  const cost = report.llmUsage ? ` (~${Math.round((report.llmUsage.totalPromptTokens + report.llmUsage.totalCompletionTokens) / 1000)}k tokens, $${report.llmUsage.totalCostUsd.toFixed(4)})` : '';
  const text = `📊 Daily Top-5 research (${report.date})${cost}\n${lines.join('\n')}${freshLines.length ? '\n\nFresh candidates today:\n' + freshLines.join('\n') : ''}${failed ? `\n(${failed} symbol(s) failed)` : ''}`;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, report }),
    signal: AbortSignal.timeout(10_000),
  })
    .then(() => deps.appLog.info({ span: 'verdict.daily', msg: 'daily report webhook delivered' }))
    .catch((err) => deps.appLog.warn({ span: 'verdict.daily', msg: `daily report webhook failed: ${err.message}` }));
}

// ---- Report read model -------------------------------------------------------
export function getDailyReport() {
  // Latest available report (today's if present, else the most recent one).
  let files = [];
  try {
    files = fs.readdirSync(DAILY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  } catch {
    return { available: false };
  }
  if (!files.length) return { available: false };
  const today = new Date().toISOString().slice(0, 10);
  const latestFile = files[0];
  const report = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, latestFile), 'utf8'));
  const universe = readUniverse();
  return {
    available: true,
    isToday: latestFile === `${today}.json`,
    nextRunAt: nextRunIso(),
    universe: universe ? { weekTag: universe.weekTag, builtAt: universe.builtAt, symbols: universe.symbols.map((s) => ({ symbol: s.symbol, name: s.name, qualityScore: s.qualityScore })) } : null,
    ...report,
  };
}

// ---- Scheduler (DST-safe) -----------------------------------------------------
/** Convert a wall-clock time in a tz to a UTC ms timestamp (two-pass offset). */
function zonedToUtcMs(y, m, d, hh, mm, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  let ts = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(y, m - 1, d, hh, mm);
    const rendered = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    ts += asUtc - rendered;
  }
  return ts;
}

/** Next weekday 08:30 ET strictly in the future (skips Sat/Sun). */
export function nextRunMs(from = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let add = 0; add <= 4; add++) {
    const dt = new Date(from + add * 86400000);
    const [y, m, d] = fmt.format(dt).split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const ts = zonedToUtcMs(y, m, d, RUN_HOUR_ET, RUN_MINUTE_ET, 'America/New_York');
    if (ts > from + 30_000) return ts;
  }
  return from + 3600_000; // unreachable fallback
}

function nextRunIso() {
  return new Date(nextRunMs()).toISOString();
}

export function scheduleDailyReport() {
  const fire = async () => {
    try {
      await runDailyReport('scheduled');
    } catch (err) {
      deps.appLog.warn({ span: 'verdict.daily', msg: `scheduled run failed: ${err.message}` });
    }
    scheduleDailyReport(); // re-arm for the next day
  };
  const ms = nextRunMs();
  deps.appLog.info({ span: 'verdict.daily', msg: `daily run scheduled`, nextRunAt: new Date(ms).toISOString() });
  setTimeout(fire, ms - Date.now()).unref();
}

/** Startup catch-up: if today is a weekday and no report exists yet, run now. */
export function catchUpDailyReport() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const weekday = parts.weekday;
  if (weekday === 'Sat' || weekday === 'Sun') return;
  try {
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    fs.accessSync(path.join(DAILY_DIR, `${today}.json`));
    return; // already ran today
  } catch {
    // no report yet today — run after the mesh settles
    setTimeout(() => runDailyReport('catch-up').catch((e) => deps.appLog.warn({ span: 'verdict.daily', msg: `catch-up failed: ${e.message}` })), 25_000).unref();
  }
}
