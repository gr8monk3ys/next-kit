/**
 * Rate-limit stores.
 *
 * A store owns one thing: "bump the counter for this key and tell me where the
 * current window stands". The algorithm is a **fixed window** — see the
 * "Fixed window, not sliding" section of the README for why.
 */

/** What a store returns after counting one request against `key`. */
export interface StoreHit {
  /** How many requests (including this one) have landed in the current window. */
  count: number;
  /** Epoch ms at which the current window expires. */
  resetAt: number;
}

export interface RateLimitStore {
  /**
   * Count one request against `key` inside a window of `windowMs`, and report
   * the resulting count plus the window's expiry.
   */
  hit(key: string, windowMs: number): Promise<StoreHit> | StoreHit;
  /** Forget everything recorded for `key`. */
  reset(key: string): Promise<void> | void;
  /** Drop expired entries. A no-op for stores that expire keys themselves. */
  cleanup(): Promise<void> | void;
}

interface MemoryEntry {
  count: number;
  resetAt: number;
}

/**
 * In-process fixed-window counter.
 *
 * The shape every hand-rolled fallback limiter converges on: a
 * `{ count, resetAt }` pair per key, with a fresh window started once `resetAt`
 * has passed.
 *
 * It does not survive a restart and it does not coordinate across instances —
 * both true of every implementation it replaces. Use `RedisStore` when either
 * matters.
 */
export class MemoryStore implements RateLimitStore {
  private entries = new Map<string, MemoryEntry>();
  private lastCleanup = 0;

  /** Milliseconds between opportunistic sweeps of expired keys. */
  constructor(private readonly cleanupIntervalMs = 60_000) {}

  hit(key: string, windowMs: number): StoreHit {
    this.maybeCleanup();

    const now = Date.now();
    const entry = this.entries.get(key);

    if (!entry || now >= entry.resetAt) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.entries.set(key, fresh);
      return { ...fresh };
    }

    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
  }

  /** Number of keys currently tracked. Exposed for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;
    this.cleanup();
  }
}

/**
 * The slice of a Redis client this package needs.
 *
 * Satisfied as-is by `ioredis` and by `@upstash/redis`'s REST client — both
 * expose `incr`, `pexpire`, `pttl` and `del` with these signatures.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number | boolean>;
  pttl(key: string): Promise<number>;
  del(key: string): Promise<number | unknown>;
}

export interface RedisStoreOptions {
  /** Key prefix. Default `"ratelimit:"`. */
  prefix?: string;
  /**
   * What to do when Redis throws. `"open"` (default) lets the request through —
   * an outage must not turn every request into a 500. `"closed"` rejects it.
   */
  onError?: "open" | "closed";
  /** Called with the error whenever a Redis call fails. */
  onErrorLog?: (error: unknown) => void;
}

/**
 * Distributed fixed-window counter over `INCR` + `PEXPIRE`.
 *
 * `INCR` on a missing key creates it at 1; that first request is the one that
 * sets the TTL, so the window starts with the first request and expires on its
 * own. `PTTL` supplies `resetAt` without a second round trip's worth of clock
 * skew.
 */
export class RedisStore implements RateLimitStore {
  private readonly prefix: string;
  private readonly onError: "open" | "closed";
  private readonly onErrorLog?: (error: unknown) => void;

  constructor(
    private readonly redis: RedisLike,
    options: RedisStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? "ratelimit:";
    this.onError = options.onError ?? "open";
    this.onErrorLog = options.onErrorLog;
  }

  async hit(key: string, windowMs: number): Promise<StoreHit> {
    const redisKey = `${this.prefix}${key}`;
    const now = Date.now();

    try {
      const count = await this.redis.incr(redisKey);

      // First request in this window: give the key a TTL so it expires itself.
      if (count === 1) {
        await this.redis.pexpire(redisKey, windowMs);
        return { count, resetAt: now + windowMs };
      }

      const ttl = await this.redis.pttl(redisKey);
      // -1 = key exists with no TTL (a PEXPIRE that never landed), -2 = gone.
      // Either way, re-arm the expiry rather than leaking a key forever.
      if (ttl < 0) {
        await this.redis.pexpire(redisKey, windowMs);
        return { count, resetAt: now + windowMs };
      }

      return { count, resetAt: now + ttl };
    } catch (error) {
      this.onErrorLog?.(error);
      if (this.onError === "closed") throw error;
      // Fail open: report a first-of-window hit so the caller admits it.
      return { count: 1, resetAt: now + windowMs };
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(`${this.prefix}${key}`);
    } catch (error) {
      this.onErrorLog?.(error);
    }
  }

  /** No-op: Redis expires the keys itself. */
  cleanup(): void {}
}
