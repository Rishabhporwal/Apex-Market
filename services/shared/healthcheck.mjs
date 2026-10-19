#!/usr/bin/env node
// Container healthcheck: GET /healthz on $PORT (default 8080), exit 0 on 2xx.
// Kept as a file to avoid YAML quote-escaping of inline node -e one-liners.
const port = process.env.PORT || '8080';
try {
  const res = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(2500) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
