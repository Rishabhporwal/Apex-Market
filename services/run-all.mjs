#!/usr/bin/env node
/**
 * svc:start — spawn every Phase-1 service, then tail their log files with
 * colored prefix logs (like `docker-compose up`). Ctrl-C detaches the tailer;
 * services keep running. svc:stop — SIGTERM every tracked service.
 *
 * Why log files instead of direct stdio pipes: the parent must be able to exit
 * (or be Ctrl-C'd) without killing or EPIPE-ing the services. Each service
 * streams JSON to services/.run/<name>.log; the tailer colorizes/prefixes it.
 *
 * Each service is also individually startable: `npm run svc:<name>`.
 *
 * Usage: node services/run-all.mjs [start|stop]   (start is default)
 *        SVC_NOFOLLOW=1 npm run svc:start   → spawn and exit (no tailing)
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const RUN_DIR = path.join(ROOT, 'services', '.run');
const PID_FILE = path.join(RUN_DIR, 'services.pids.json');

const SERVICES = [
  { name: 'registry', port: 8010 },
  { name: 'market-data', port: 8001 },
  { name: 'edgar', port: 8002 },
  { name: 'verdict', port: 8003 },
  { name: 'news', port: 8004 },
  { name: 'llm', port: 8005 },
  { name: 'research', port: 8006 },
  { name: 'analytics', port: 8007 },
  { name: 'gateway', port: 8080 },
];

const COLORS = {
  registry: '\x1b[36m',
  'market-data': '\x1b[32m',
  edgar: '\x1b[33m',
  verdict: '\x1b[35m',
  news: '\x1b[34m',
  llm: '\x1b[91m',
  research: '\x1b[96m',
  analytics: '\x1b[93m',
  gateway: '\x1b[92m',
};
const RESET = '\x1b[0m';

function readPids() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return {}; }
}

function writePids(pids) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isPortBusy(port) {
  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function start() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const pids = readPids();
  let started = 0;
  for (const svc of SERVICES) {
    const existing = pids[svc.name];
    if (existing && alive(existing)) {
      console.log(`[svc] ${svc.name} already running (pid ${existing}) — skipping`);
      continue;
    }
    if (isPortBusy(svc.port)) {
      console.log(`[svc] port ${svc.port} busy — assuming ${svc.name} already running, skipping`);
      continue;
    }
    const logFile = path.join(RUN_DIR, `${svc.name}.log`);
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'services', svc.name, 'index.mjs')], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', out, out],
    });
    fs.closeSync(out);
    pids[svc.name] = child.pid;
    child.unref();
    started++;
    console.log(`[svc] started ${svc.name} (pid ${child.pid}) on :${svc.port} → services/.run/${svc.name}.log`);
    // give each service a moment so startup order (registry first) is respected
    await new Promise((r) => setTimeout(r, 700));
  }
  writePids(pids);
  console.log(`[svc] ${started} service(s) launched. Follow logs: tail -f services/.run/*.log, stop: npm run svc:stop`);

  if (process.env.SVC_NOFOLLOW === '1') return;

  // ---- Colored prefix tailer (Ctrl-C detaches; services keep running) ----
  const tailers = [];
  for (const svc of SERVICES) {
    const logFile = path.join(RUN_DIR, `${svc.name}.log`);
    const color = COLORS[svc.name] || '';
    const t = spawn('tail', ['-n', '40', '-f', logFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    t.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) process.stdout.write(`${color}[${svc.name}]${RESET} ${line}\n`);
      }
    });
    tailers.push(t);
  }

  console.log('[svc] tailing logs — Ctrl-C to detach (services keep running), `npm run svc:stop` to stop services.');
  const detach = () => {
    for (const t of tailers) { try { t.kill('SIGTERM'); } catch { /* gone */ } }
    process.exit(0);
  };
  process.on('SIGINT', detach);
  process.on('SIGTERM', detach);
  // Keep the foreground tailer alive; tail child handles are what hold the loop.
}

async function stop() {
  const pids = readPids();
  let any = false;
  for (const [name, pid] of Object.entries(pids)) {
    if (!alive(pid)) continue;
    any = true;
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[svc] stopped ${name} (pid ${pid})`);
    } catch (err) {
      console.warn(`[svc] could not stop ${name} (pid ${pid}): ${err.message}`);
    }
  }
  writePids({});
  if (!any) console.log('[svc] no tracked services running');
}

const cmd = process.argv[2] || 'start';
if (cmd === 'stop') await stop();
else if (cmd === 'start') await start();
else {
  console.error('usage: node services/run-all.mjs [start|stop]');
  process.exit(1);
}
