/**
 * Simple TTL cache with stale-while-error semantics.
 *
 * Purpose (Tier-1 hardening): Yahoo rate-limits aggressively; every AI verdict
 * currently re-fetches quotes, candles and news live. This cache absorbs
 * repeat traffic within TTL windows and, on upstream failure, serves the last
 * known-good value instead of failing the request.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
  storedAt: number;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private inFlight = new Map<string, Promise<T>>();

  constructor(
    private ttlMs: number,
    private maxEntries = 500,
    private name = 'cache'
  ) {}

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined; // expired (lazy eviction)
    return e.value;
  }

  /** Stale value even if expired — used as fallback when upstream fails. */
  getStale(key: string): T | undefined {
    return this.store.get(key)?.value;
  }

  set(key: string, value: T): void {
    // Evict oldest when full (Map preserves insertion order).
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs, storedAt: Date.now() });
  }

  /**
   * Get-or-fetch with single-flight dedup: concurrent callers asking for the
   * same key share one upstream call. On upstream failure, falls back to the
   * stale value when one exists.
   */
  async wrap(key: string, fetcher: () => Promise<T>): Promise<T> {
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

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

// Process-wide shared caches. TTLs tuned per data volatility.
import type { StockQuote, Candle } from '@/types';
import type { NewsDriversResult } from '@/services/newsDrivers';
export const quoteCache = new TtlCache<StockQuote>(60_000, 1_000, 'quotes'); // 60s — prices move fast
export const candlesCache = new TtlCache<Candle[]>(10 * 60_000, 500, 'candles'); // 10min — daily bars barely move intraday
export const newsCache = new TtlCache<NewsDriversResult>(10 * 60_000, 500, 'news'); // 10min — news cycles in minutes, not seconds
