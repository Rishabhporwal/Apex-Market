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
const UNIVERSE_SIZE = 8;
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

async function buildUniverse(ctx) {
  const { resolveService, httpClient, appLog } = deps;
  const base = await resolveService('edgar', ctx);
  // Quality screen mirrors the platform's 'quality' preset (growth 10%+,
  // margin 10%+, ROE 12%+), fetched wide then ranked by the composite score.
  const res = await httpClient.fetch(
    `${base}/screener?minRevenueGrowth=10&minNetMargin=10&minRoe=12&limit=80`,
    { ctx, span: 'verdict.daily.universe', timeoutMs: 60_000, log: appLog }
  );
  const rows = res.json?.results || [];
  if (!rows.length) throw new Error('quality screen returned no companies — is the EDGAR warehouse populated?');
  const ranked = rows
    .map((r) => ({
      symbol: r.symbol,
      name: r.name,
      qualityScore: qualityScore(r),
      metrics: {
        revenueGrowthYoY: r.revenueGrowthYoY,
        netMargin: r.netMargin,
        roe: r.roe,
        peRatio: r.peRatio,
        marketCap: r.marketCap,
      },
    }))
    .sort((a, b) => b.qualityScore - a.qualityScore || (b.metrics.marketCap || 0) - (a.metrics.marketCap || 0))
    .slice(0, UNIVERSE_SIZE);
  return ranked;
}

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
  if (!force && existing && existing.weekTag === tag && ageDays < UNIVERSE_REFRESH_DAYS) return existing;
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
        results.push({
          symbol: v.symbol,
          name: v.name,
          action: v.verdict.action,
          confidence: v.verdict.confidence,
          score: v.breakdown?.score,
          horizon: v.verdict.horizon,
          price: v.price,
          buyZone: v.strategy?.entry || null,
          target1: v.levels?.target1,
          target2: v.levels?.target2,
          stopLoss: v.levels?.stopLoss,
          reason: v.verdict.summary,
          earnings: v.earnings || null,
          cachedAnalysis: !!v.meta?.researchCached,
        });
      } catch (err) {
        results.push({ symbol: u.symbol, name: u.name, error: err.message });
        appLog.warn({ span: 'verdict.daily', msg: `daily run: ${u.symbol} failed: ${err.message}` });
      }
    }

    const succeeded = results.filter((r) => !r.error);
    succeeded.sort((a, b) => (b.score ?? b.confidence) - (a.score ?? a.confidence));
    const ordered = [...succeeded, ...results.filter((r) => r.error)];

    const report = {
      date: new Date().toISOString().slice(0, 10),
      ranAt: startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      universeWeek: universe.weekTag,
      universeBuiltAt: universe.builtAt,
      count: succeeded.length,
      results: ordered,
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
  const failed = report.results.filter((r) => r.error).length;
  const text = `📊 Daily Top-15 research (${report.date})\n${lines.join('\n')}${failed ? `\n(${failed} symbol(s) failed)` : ''}`;
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
