#!/usr/bin/env node
/**
 * svc-userdata (port 8008) — watchlists + verdict-change alerts per ADR-001.
 *
 * Identity model (day-one, documented): every request carries an
 * `x-client-id` header set by the BFF. There is NO auth yet — client_id is a
 * stable anonymous device id, not a user identity. A missing header means
 * client_id='anonymous'.
 *
 * Storage: SQLite (better-sqlite3, WAL) at data/userdata.db. This service is
 * the ONLY writer to that file; it never touches warehouse.duckdb or
 * prices.duckdb (data-ownership boundary per ARCHITECTURE.md).
 *
 * Alert checker: every 5 minutes (plus one run ~30s after startup) it pulls
 * the verdict for each DISTINCT watched symbol from svc-verdict, updates
 * verdict_snapshots, and inserts an alert for every client watching a symbol
 * whose action CHANGED vs the stored snapshot (only when a previous snapshot
 * existed). Individual symbol failures are logged and skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startService, loadEnvLocal, httpClient, logger } from '../shared/lib.mjs';

loadEnvLocal();
const log = logger('svc-userdata');
const PORT = Number(process.env.PORT || 8008);
const DATA_DIR = path.join(process.env.DATA_DIR || '/app/data', '');
const DB_PATH = path.join(DATA_DIR, 'userdata.db');

// ---- Storage (SQLite via better-sqlite3) -----------------------------------
const Database = (await import('better-sqlite3')).default;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    client_id TEXT NOT NULL,
    symbol    TEXT NOT NULL,
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (client_id, symbol)
  );
  CREATE TABLE IF NOT EXISTS verdict_snapshots (
    symbol     TEXT PRIMARY KEY,
    action     TEXT NOT NULL,
    confidence INTEGER,
    price      REAL,
    checked_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    from_action TEXT,
    to_action   TEXT,
    confidence  INTEGER,
    price       REAL,
    created_at  INTEGER NOT NULL,
    seen        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_client ON alerts (client_id, seen);
`);

// ---- Identity ---------------------------------------------------------------
function clientIdFor(req) {
  const v = req.headers['x-client-id'];
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 128);
  return 'anonymous';
}

// ---- Watchlist validation ---------------------------------------------------
const SYMBOL_RE = /^[A-Z0-9.\-]{1,6}$/;
function cleanSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw Object.assign(new Error(`invalid symbol "${s}" (1-6 chars A-Z0-9.-)`), { statusCode: 400 });
  return s;
}

const insertWatch = db.prepare('INSERT OR IGNORE INTO watchlist (client_id, symbol, added_at) VALUES (?, ?, ?)');
const deleteWatch = db.prepare('DELETE FROM watchlist WHERE client_id = ? AND symbol = ?');
const listWatch = db.prepare('SELECT symbol, added_at FROM watchlist WHERE client_id = ? ORDER BY added_at ASC, symbol ASC');
const allSnapshots = db.prepare('SELECT * FROM verdict_snapshots');
const getSnapshot = db.prepare('SELECT * FROM verdict_snapshots WHERE symbol = ?');
const upsertSnapshot = db.prepare(`
  INSERT INTO verdict_snapshots (symbol, action, confidence, price, checked_at)
  VALUES (@symbol, @action, @confidence, @price, @checked_at)
  ON CONFLICT(symbol) DO UPDATE SET
    action = excluded.action, confidence = excluded.confidence,
    price = excluded.price, checked_at = excluded.checked_at
`);
const watchersOf = db.prepare('SELECT DISTINCT client_id FROM watchlist WHERE symbol = ?');
const insertAlert = db.prepare(`
  INSERT INTO alerts (client_id, symbol, from_action, to_action, confidence, price, created_at, seen)
  VALUES (@client_id, @symbol, @from_action, @to_action, @confidence, @price, @created_at, 0)
`);
const listAlerts = db.prepare('SELECT * FROM alerts WHERE client_id = ? AND (? = 0 OR seen = 0) ORDER BY created_at DESC, id DESC LIMIT 200');
const countUnseen = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE client_id = ? AND seen = 0');
const markSeen = db.prepare('UPDATE alerts SET seen = 1 WHERE id = ? AND client_id = ?');
const distinctSymbols = db.prepare('SELECT DISTINCT symbol FROM watchlist');

/** Shape a watchlist row the way the API contract wants (with last verdict). */
function watchlistResponse(clientId) {
  const snaps = new Map(allSnapshots.all().map((s) => [s.symbol, s]));
  const symbols = listWatch.all(clientId).map((r) => {
    const s = snaps.get(r.symbol);
    return {
      symbol: r.symbol,
      addedAt: r.added_at,
      lastVerdict: s ? { action: s.action, confidence: s.confidence, price: s.price, checkedAt: s.checked_at } : null,
    };
  });
  return { symbols };
}

function alertRow(a) {
  return {
    id: a.id, symbol: a.symbol, fromAction: a.from_action, toAction: a.to_action,
    confidence: a.confidence, price: a.price, createdAt: a.created_at, seen: !!a.seen,
  };
}

// ---- Alert checker ----------------------------------------------------------
const SERVICES = process.env.SERVICES_JSON
  ? JSON.parse(process.env.SERVICES_JSON)
  : { verdict: 'http://localhost:8003', registry: 'http://localhost:8010' };

function resolveServiceUrl(name) {
  return SERVICES[name] || null;
}

let checking = false;
async function runCheckCycle(reason = 'scheduled') {
  if (checking) return { skipped: true, reason: 'already-running' };
  checking = true;
  const cycleLog = { checked: 0, changed: 0, alerts: 0, failed: 0 };
  try {
    const symbols = distinctSymbols.all().map((r) => r.symbol);
    for (const symbol of symbols) {
      try {
        const base = resolveServiceUrl('verdict');
        if (!base) throw new Error('no verdict service in SERVICES_JSON');
        // LLM narratives are slow — verdict service may take a while (60s timeout).
        const res = await httpClient.fetch(`${base}/verdict?symbol=${encodeURIComponent(symbol)}`, {
          span: 'userdata.check.verdict', timeoutMs: 60_000, log,
        });
        const v = res.json || {};
        // AiVerdict shape: { price, verdict: { action, confidence }, ... }
        const action = v?.verdict?.action;
        if (!res.ok || !action) throw new Error(`bad verdict response (${res.status})`);
        const now = Date.now();
        const prev = getSnapshot.get(symbol);
        const snap = {
          symbol, action,
          confidence: typeof v.verdict.confidence === 'number' ? Math.round(v.verdict.confidence) : null,
          price: typeof v.price === 'number' ? v.price : null,
          checked_at: now,
        };
        const tx = db.transaction(() => {
          upsertSnapshot.run(snap);
          if (prev && prev.action !== action) {
            for (const w of watchersOf.all(symbol)) {
              insertAlert.run({
                client_id: w.client_id, symbol,
                from_action: prev.action, to_action: action,
                confidence: snap.confidence, price: snap.price, created_at: now,
              });
              cycleLog.alerts += 1;
            }
            cycleLog.changed += 1;
          }
        });
        tx();
        cycleLog.checked += 1;
      } catch (err) {
        cycleLog.failed += 1;
        log.warn({ span: 'userdata.check', msg: `check failed for ${symbol}: ${err.message}`, symbol, error: err.message });
      }
    }
    log.info({ span: 'userdata.check', msg: `check cycle (${reason}) done`, ...cycleLog });
    return { skipped: false, ...cycleLog };
  } finally {
    checking = false;
  }
}

// ---- HTTP surface -----------------------------------------------------------
const { app, listen, close } = await startService({
  name: 'svc-userdata',
  port: PORT,
  healthDeps: async () => {
    // ready = the database actually accepts writes
    db.prepare('INSERT INTO verdict_snapshots (symbol, action, confidence, price, checked_at) VALUES (?, ?, ?, ?, ?)')
      .run('__readyz__', 'ok', null, null, Date.now());
    db.prepare('DELETE FROM verdict_snapshots WHERE symbol = ?').run('__readyz__');
    return { ok: true, db: path.basename(DB_PATH) };
  },
});

app.get('/watchlist', async (req) => watchlistResponse(clientIdFor(req)));

app.post('/watchlist', async (req, reply) => {
  const clientId = clientIdFor(req);
  const symbol = cleanSymbol(req.body?.symbol);
  insertWatch.run(clientId, symbol, Date.now());
  return watchlistResponse(clientId);
});

app.delete('/watchlist/:symbol', async (req) => {
  const clientId = clientIdFor(req);
  const symbol = cleanSymbol(req.params.symbol);
  deleteWatch.run(clientId, symbol);
  return watchlistResponse(clientId);
});

app.get('/alerts', async (req) => {
  const clientId = clientIdFor(req);
  const unseenOnly = req.query.unseen === '1' || req.query.unseen === 'true';
  const alerts = listAlerts.all(clientId, unseenOnly ? 1 : 0).map(alertRow);
  return { alerts, unseenCount: countUnseen.get(clientId).n };
});

app.post('/alerts/seen', async (req) => {
  const clientId = clientIdFor(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((n) => Number.isInteger(n)) : [];
  const mark = db.transaction((list) => {
    let n = 0;
    for (const id of list) n += markSeen.run(id, clientId).changes;
    return n;
  });
  const updated = mark(ids);
  const alerts = listAlerts.all(clientId, 0).map(alertRow);
  return { updated, alerts, unseenCount: countUnseen.get(clientId).n };
});

app.post('/check-now', async () => runCheckCycle('check-now'));

await listen();
log.info({ msg: `svc-userdata ready, db=${DB_PATH}` });

// One check ~30s after startup, then every 5 minutes.
setTimeout(() => { void runCheckCycle('startup'); }, 30_000).unref();
const CHECK_INTERVAL_MS = 5 * 60_000;
setInterval(() => { void runCheckCycle('scheduled'); }, CHECK_INTERVAL_MS).unref();

process.on('SIGINT', () => { void close().then(() => { db.close(); process.exit(0); }); });
process.on('SIGTERM', () => { void close().then(() => { db.close(); process.exit(0); }); });
