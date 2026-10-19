#!/usr/bin/env node
/**
 * svc-registry (port 8010) — service discovery per ADR-001.
 *
 * POST /register     {name, host, port, healthPath}
 * POST /heartbeat    {name}
 * GET  /resolve/:name
 * GET  /services     (dashboard JSON)
 *
 * Entries expire 45s without a heartbeat. In-memory only.
 */
import { startService, loadEnvLocal } from '../shared/lib.mjs';

loadEnvLocal();
const NAME = 'svc-registry';
const PORT = Number(process.env.PORT || 8010);
const TTL_MS = 45_000; // 3 missed heartbeats (15s each) → expired

/** @type {Map<string, {name:string, host:string, port:number, healthPath:string, lastSeen:number}>} */
const services = new Map();

function isAlive(entry) {
  return Date.now() - entry.lastSeen <= TTL_MS;
}

function prune() {
  for (const [name, entry] of services) {
    if (!isAlive(entry)) services.delete(name);
  }
}

const { app, listen, close } = await startService({
  name: NAME,
  port: PORT,
  healthDeps: async () => ({ ok: true, registeredServices: services.size }),
});

app.post('/register', async (req, reply) => {
  const { name, host, port, healthPath } = req.body || {};
  if (!name || !port) return reply.status(400).send({ error: 'name and port are required' });
  const existing = services.get(name);
  services.set(name, {
    name,
    host: host || 'localhost',
    port: Number(port),
    healthPath: healthPath || '/healthz',
    lastSeen: Date.now(),
  });
  return { ok: true, name, reregistered: Boolean(existing) };
});

app.post('/heartbeat', async (req, reply) => {
  const { name } = req.body || {};
  const entry = name ? services.get(name) : undefined;
  if (!entry) return reply.status(404).send({ error: `unknown service: ${name}` });
  entry.lastSeen = Date.now();
  return { ok: true, name, ttlMs: TTL_MS };
});

app.get('/resolve/:name', async (req, reply) => {
  prune();
  const entry = services.get(req.params.name);
  if (!entry || !isAlive(entry)) return reply.status(404).send({ error: `no live instance of ${req.params.name}` });
  return { name: entry.name, url: `http://${entry.host}:${entry.port}`, lastSeen: entry.lastSeen };
});

app.get('/services', async () => {
  prune();
  const now = Date.now();
  return {
    services: [...services.values()].map((s) => ({
      name: s.name,
      url: `http://${s.host}:${s.port}`,
      healthPath: s.healthPath,
      lastSeenAgoMs: now - s.lastSeen,
      expiresInSeconds: Math.max(0, Math.round((TTL_MS - (now - s.lastSeen)) / 1000)),
    })),
    registryTtlMs: TTL_MS,
  };
});

await listen();
process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });
