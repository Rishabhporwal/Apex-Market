#!/usr/bin/env node
/**
 * Pre-market price refresh guard — run by launchd every 30 minutes
 * (com.tradexa.refresh-prices.plist).
 *
 * Why a guard instead of a fixed 07:30 calendar job? Sleep. A calendar job that
 * fires while the lid is closed is simply missed. A 30-minute StartInterval
 * tick survives sleep (launchd runs one missed tick on wake) and this wrapper
 * decides whether the tick is useful:
 *
 *   1. Skip Sat/Sun (America/New_York) — market is closed.
 *   2. Only run inside the 07:25–08:10 ET window — enough time for the ~15 min
 *      --index-universe refresh to finish well before the 08:30 ET analysis
 *      (svc-verdict scheduleDailyReport), and late enough that a wake-up just
 *      before 07:30 still lands in the window.
 *   3. Skip if data/.last-price-refresh (ET date string) already == today.
 *   4. Skip if another refresh holds data/.refresh-lock (stale lock > 30 min
 *      is broken so a crashed run can't wedge the schedule).
 *
 * On success it stamps the state file and appends to data/refresh-cron.log.
 * Outside-window ticks exit silently — the log stays readable.
 *
 * DST-safe: the window is evaluated in America/New_York every run (never a
 * fixed UTC offset), and StartInterval ticks don't reference wall-clock time.
 * A missed window = skipped day; tomorrow's ticks retry automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, '.last-price-refresh');
const LOCK_FILE = path.join(DATA, '.refresh-lock');
const LOG_FILE = path.join(DATA, 'refresh-cron.log');
const REFRESH_SCRIPT = path.join(ROOT, 'scripts', 'refresh-prices.mjs');

const WINDOW_START = 7 * 60 + 25; // 07:25 ET
const WINDOW_END = 8 * 60 + 10;   // 08:10 ET
const LOCK_STALE_MS = 30 * 60 * 1000;

function etNow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes,
    weekend: p.weekday === 'Sat' || p.weekday === 'Sun',
    label: `${p.hour}:${p.minute} ET`,
  };
}

function log(msg) {
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
}

function readState() {
  try { return fs.readFileSync(STATE_FILE, 'utf8').trim(); } catch { return null; }
}

function breakStaleLock() {
  try {
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(LOCK_FILE);
      log(`lock stale (${new Date(stat.mtimeMs).toISOString()}) — broken`);
      return true;
    }
    return false;
  } catch { return true; } // no lock present
}

function runRefresh() {
  return new Promise((resolve) => {
    const started = Date.now();
    log(`starting refresh-prices --index-universe (et=${etNow().label})`);
    const child = spawn(process.execPath, [REFRESH_SCRIPT, '--index-universe'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => log(`[refresh] ${String(d).trim()}`));
    child.stderr.on('data', (d) => log(`[refresh:err] ${String(d).trim()}`));
    child.on('error', (err) => resolve({ ok: false, ms: Date.now() - started, err: String(err) }));
    child.on('close', (code) => resolve({ ok: code === 0, ms: Date.now() - started, code }));
  });
}

async function main() {
  const now = etNow();
  // TRADEXA_FORCE_TICK=1 bypasses the window/weekend/state checks (testing only);
  // the lock and the state-stamp still apply.
  const forced = process.env.TRADEXA_FORCE_TICK === '1';
  if (!forced && now.weekend) return; // weekend — silent exit
  if (!forced && (now.minutes < WINDOW_START || now.minutes > WINDOW_END)) return; // outside window — silent exit

  const last = readState();
  if (!forced && last === now.date) return; // already succeeded today — silent exit

  if (!breakStaleLock()) {
    log(`another refresh is running (lock held) — skipping tick`);
    return;
  }

  try {
    fs.writeFileSync(LOCK_FILE, new Date().toISOString());
    const { ok, ms, code, err } = await runRefresh();
    if (ok) {
      fs.writeFileSync(STATE_FILE, now.date);
      log(`refresh succeeded in ${(ms / 60000).toFixed(1)} min — state stamped ${now.date}`);
    } else {
      log(`refresh FAILED (exit ${code ?? 'n/a'}, ${err ?? ''}, ${(ms / 60000).toFixed(1)} min) — state NOT stamped; next tick retries`);
    }
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

main().catch((e) => { log(`guard error: ${e?.stack || e}`); process.exit(1); });
