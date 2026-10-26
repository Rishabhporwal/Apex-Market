/**
 * ApexMarket Phase-1 shared service library (ADR-001).
 *
 * Plain ESM + JSDoc — no TS build step. Everything here maps 1:1 to the
 * interface contracts in ARCHITECTURE.md: pino JSON logs, X-Request-Id /
 * X-Trace-Id propagation, TtlCache with stale-on-error + single-flight,
 * and a Fastify bootstrap with registry auto-registration + heartbeats.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import Fastify from 'fastify';

/** Repo root (services/<name>/../../ = repo). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Load .env.local manually (KEY=VALUE lines). Never logs or echoes values.
 * Existing process.env entries win — explicit env always overrides the file.
 */
export function loadEnvLocal() {
  const envPath = path.join(REPO_ROOT, '.env.local');
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    /* no .env.local — fine */
  }
}

/** Structured JSON logger: {ts, level, service, requestId, traceId, span, msg, ...ctx}. */
export function logger(service) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

const sharedLog = pino({ base: { service: 'shared' }, level: process.env.LOG_LEVEL || 'info' });

/**
 * Extract or generate trace context from an inbound request.
 * Gateway injects X-Request-Id + X-Trace-Id; direct calls to a service get
 * fresh ids. Headers object is ready to spread onto downstream http calls.
 */
export function traceCtx(req) {
  const h = (req && req.headers) || {};
  const requestId = h['x-request-id'] || crypto.randomUUID();
  const traceId = h['x-trace-id'] || requestId;
  return {
    requestId,
    traceId,
    span: crypto.randomBytes(8).toString('hex'),
    headers: { 'x-request-id': requestId, 'x-trace-id': traceId },
  };
}

/**
 * Fetch wrapper: propagates trace headers and logs every call with duration.
 *
 *   await httpClient.fetch(url, {
 *     method: 'GET' | 'POST', body: object|null, headers: {...},
 *     ctx: traceCtx(req),          // trace propagation (optional)
 *     span: 'market-data.quote',   // logical span name for the log line
 *     timeoutMs: 8000,
 *   })
 *
 * Returns {status, ok, json, text, durationMs}. Non-2xx does NOT throw.
 *
 * Retry policy (audit fix): GET is retried up to 2 extra times on HTTP 429/5xx
 * and network errors, with 500ms/1500ms backoff. POST is retried at most once
 * (a POST with a body is never re-sent more than once). The response contract
 * is unchanged; retries are invisible to callers except in the logs.
 */
export const httpClient = {
  async fetch(url, opts = {}) {
    const { method = 'GET', body = null, headers = {}, ctx = null, span = 'http', timeoutMs = 15000, log = sharedLog } = opts;
    const traceHeaders = ctx ? ctx.headers : {};
    const verb = String(method).toUpperCase();
    const maxRetries = verb === 'GET' ? 2 : 1;
    const started = Date.now();
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = attempt === 1 ? 500 : 1500;
        log.warn({
          requestId: ctx?.requestId, traceId: ctx?.traceId, span,
          msg: `http ${verb} ${url} retry ${attempt}/${maxRetries} in ${backoffMs}ms${lastError ? ` (${lastError.message})` : ''}`,
          url, method: verb, attempt, backoffMs,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      try {
        const res = await fetch(url, {
          method: verb,
          headers: { ...traceHeaders, ...(body !== null ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body !== null ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === maxRetries) {
          const durationMs = Date.now() - started;
          log.info({
            requestId: ctx?.requestId, traceId: ctx?.traceId, span,
            msg: `http ${verb} ${url} -> ${res.status}`, url, method: verb, status: res.status,
            durationMs, attempts: attempt + 1,
          });
          return { status: res.status, ok: res.ok, json, text, durationMs };
        }
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries) {
          const durationMs = Date.now() - started;
          log.warn({
            requestId: ctx?.requestId, traceId: ctx?.traceId, span,
            msg: `http ${verb} ${url} failed (${durationMs}ms): ${err.message}`, url, method: verb, durationMs, error: err.message,
          });
          throw err;
        }
      }
    }
    /* unreachable */ 
  },
};

/**
 * TTL cache with stale-on-error + single-flight dedup.
 * Port of src/services/cacheService.ts — identical semantics:
 *  - get() returns undefined for expired entries (lazy eviction)
 *  - wrap() shares one in-flight upstream call per key
 *  - on upstream failure, serves the last known-good (stale) value
 */
export class TtlCache {
  /**
   * @param {number} ttlMs time-to-live in milliseconds
   * @param {number} maxEntries evict oldest when full (default 500)
   * @param {string} name cache name for warnings
   */
  constructor(ttlMs, maxEntries = 500, name = 'cache') {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.name = name;
    this.store = new Map(); // key -> {value, expiresAt, storedAt}
    this.inFlight = new Map(); // key -> Promise
  }

  get(key) {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined;
    return e.value;
  }

  /** Stale value even if expired — fallback when upstream fails. */
  getStale(key) {
    return this.store.get(key)?.value;
  }

  set(key, value) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs, storedAt: Date.now() });
  }

  async wrap(key, fetcher) {
    const fresh = this.get(key);
    if (fresh !== undefined) return fresh;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const p = fetcher()
      .then((v) => {
        this.set(key, v);
        return v;
      })
      .catch((err) => {
        const stale = this.getStale(key);
        if (stale !== undefined) {
          console.warn(`[${this.name}] upstream failed for ${key}, serving stale value:`, err instanceof Error ? err.message : err);
          return stale;
        }
        throw err;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, p);
    return p;
  }

  get size() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }
}

const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8010';

async function registerWithRegistry(spec, log) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${REGISTRY_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spec),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        log.info({ msg: `registered with registry (${REGISTRY_URL})`, name: spec.name });
        return true;
      }
    } catch (err) {
      log.debug({ msg: `registry register attempt ${attempt} failed: ${err.message}` });
    }
    await new Promise((r) => setTimeout(r, attempt * 500));
  }
  log.warn({ msg: `could not reach registry at ${REGISTRY_URL} — running unregistered (static fallback still works)` });
  return false;
}

/**
 * Fastify bootstrap for every service:
 *  - /healthz (liveness) and /readyz (readiness + deps)
 *  - request-id/trace-id injection hook on every inbound request
 *  - request-completion logs with status + latency
 *  - auto-registers with svc-registry and heartbeats every 15s
 *
 * @param {{name: string, port: number, healthDeps?: () => Promise<{ok: boolean, [k:string]: unknown}>}} opts
 * @returns {Promise<{app: import('fastify').FastifyInstance, listen: () => Promise<void>, close: () => Promise<void>}>}
 *   Callers MUST register routes, then `await listen()`. `close()` stops
 *   heartbeats and the server (SIGINT/SIGTERM wired automatically).
 */
export async function startService({ name, port, healthDeps }) {
  loadEnvLocal();
  const log = logger(name);
  const app = Fastify({
    logger: false, // we own logging via pino (request-completion hook below)
    trustProxy: true,
  });

  // ---- Trace context injection + request completion logging ----
  app.addHook('onRequest', async (req, reply) => {
    const ctx = traceCtx(req);
    req.traceCtx = ctx;
    reply.header('x-request-id', ctx.requestId);
    reply.header('x-trace-id', ctx.traceId);
    req._t0 = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (req, reply) => {
    const ctx = req.traceCtx || {};
    const latencyMs = req._t0 ? Number(process.hrtime.bigint() - req._t0) / 1e6 : undefined;
    log.info({
      requestId: ctx.requestId, traceId: ctx.traceId, span: `${name}.request`,
      msg: `${req.method} ${req.url} -> ${reply.statusCode}`,
      method: req.method, url: req.url, status: reply.statusCode,
      latencyMs: latencyMs !== undefined ? Math.round(latencyMs * 100) / 100 : undefined,
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const ctx = req.traceCtx || {};
    log.warn({ requestId: ctx.requestId, traceId: ctx.traceId, msg: `${req.method} ${req.url} error: ${err.message}`, error: err.message, stack: err.stack });
    reply.status(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: err.message });
  });

  // ---- Health endpoints ----
  app.get('/healthz', async () => ({ ok: true, service: name, ts: Date.now() }));
  app.get('/readyz', async (_req, reply) => {
    let deps = { ok: true };
    if (healthDeps) {
      try { deps = await healthDeps(); } catch (err) { deps = { ok: false, error: err.message }; }
    }
    if (!deps.ok) return reply.status(503).send({ ok: false, service: name, deps });
    return { ok: true, service: name, deps, ts: Date.now() };
  });

  // ---- Registry registration + heartbeat (every 15s per ADR-001) ----
  // Started only when the caller invokes listen() — after route registration —
  // and only once the service can actually answer /healthz.
  const spec = { name, host: process.env.SERVICE_HOST || 'localhost', port, healthPath: '/healthz' };
  let heartbeat = null;
  const startRegistryClient = () => {
    void registerWithRegistry(spec, log);
    heartbeat = setInterval(async () => {
      try {
        await fetch(`${REGISTRY_URL}/heartbeat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(2000),
        });
      } catch (err) {
        // Re-register once if the registry lost us (e.g. registry restart).
        try {
          const res = await fetch(`${REGISTRY_URL}/register`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(spec), signal: AbortSignal.timeout(2000),
          });
          if (res.ok) return;
        } catch { /* both failed */ }
        log.debug({ msg: `heartbeat failed: ${err.message}` });
      }
    }, 15000);
    heartbeat.unref();
  };

  const listen = async () => {
    await app.listen({ port, host: process.env.SERVICE_BIND || '127.0.0.1' });
    log.info({ msg: `${name} listening on :${port}`, port });
    startRegistryClient();
  };

  const close = async () => {
    if (heartbeat) clearInterval(heartbeat);
    await app.close();
    log.info({ msg: `${name} shut down` });
  };
  process.on('SIGINT', () => { void close().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void close().then(() => process.exit(0)); });

  return { app, listen, close };
}
