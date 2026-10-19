#!/usr/bin/env node
/** Single-service stop helper: `node services/stop-one.mjs <name>` */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PID_FILE = path.join(ROOT, 'services', '.run', 'services.pids.json');
const name = process.argv[2];

if (!name) {
  console.error('usage: node services/stop-one.mjs <service-name>');
  process.exit(1);
}

let pids = {};
try { pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { /* none */ }
const pid = pids[name];
if (pid) {
  try { process.kill(pid, 'SIGTERM'); console.log(`stopped ${name} (pid ${pid})`); }
  catch (err) { console.warn(`could not stop ${name}: ${err.message}`); }
  delete pids[name];
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
} else {
  console.log(`no tracked pid for ${name}`);
}
