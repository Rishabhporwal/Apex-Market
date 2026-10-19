/**
 * Service discovery helper for mesh services that call sibling services
 * (per ADR-001: services never call each other's databases, but HTTP calls
 * between planes are expected — verdict already does this).
 *
 * Resolution order mirrors api-gateway:
 *   1. svc-registry /resolve/:name  (10s cache)
 *   2. SERVICES_JSON static map     (docker-compose sets it)
 *   3. localhost default port       (host-mode dev fallback)
 */
const DEFAULT_PORTS = {
  'market-data': 8001,
  edgar: 8002,
  verdict: 8003,
  news: 8004,
  llm: 8005,
  research: 8006,
  analytics: 8007,
  registry: 8010,
};

const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:8010';

function servicesJson() {
  if (!process.env.SERVICES_JSON) return {};
  try {
    return JSON.parse(process.env.SERVICES_JSON) || {};
  } catch {
    return {};
  }
}

const resolveCache = new Map(); // name -> {url, until}

export async function resolveService(name) {
  const cached = resolveCache.get(name);
  if (cached && Date.now() < cached.until) return cached.url;

  try {
    const res = await fetch(`${REGISTRY_URL}/resolve/${name}`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const json = await res.json();
      if (json?.url) {
        resolveCache.set(name, { url: json.url, until: Date.now() + 10_000 });
        return json.url;
      }
    }
  } catch { /* registry down → static fallback */ }

  const fallback = servicesJson()[name] || `http://localhost:${DEFAULT_PORTS[name] || 8000}`;
  if (!fallback) throw new Error(`unknown service: ${name}`);
  resolveCache.set(name, { url: fallback, until: Date.now() + 10_000 });
  return fallback;
}
