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

/**
 * Runs one parameterized statement (`$1`, `$2`, …) and resolves to its rows.
 *
 * A function rather than a client shape, because no two Postgres clients agree
 * on one. Each is a one-line adapter:
 *
 * ```ts
 * // pg / @vercel/postgres
 * (text, params) => pool.query(text, params).then((r) => r.rows)
 * // @neondatabase/serverless
 * (text, params) => sql.query(text, params)
 * // Prisma
 * (text, params) => prisma.$queryRawUnsafe(text, ...params)
 * // postgres.js
 * (text, params) => sql.unsafe(text, params)
 * ```
 */
export type PostgresQuery = (
  text: string,
  params: unknown[],
) => Promise<Record<string, unknown>[]>;

export interface PostgresStoreOptions {
  /**
   * Table holding the counters, optionally schema-qualified. Default
   * `"rate_limits"`. Create it with {@link postgresStoreSchema}.
   */
  table?: string;
  /**
   * What to do when the query throws. `"open"` (default) lets the request
   * through, as `RedisStore` does. `"closed"` rejects it.
   */
  onError?: "open" | "closed";
  /** Called with the error whenever a query fails. */
  onErrorLog?: (error: unknown) => void;
  /**
   * Milliseconds between opportunistic sweeps of expired rows, run from `hit`.
   * Default 5 minutes; `0` disables them, for apps that call `cleanup()` from a
   * cron instead.
   */
  cleanupIntervalMs?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function assertTable(table: string): string {
  // The table name is interpolated into the SQL, so it must be an identifier
  // and nothing else.
  if (!IDENTIFIER.test(table)) {
    throw new Error(`Invalid rate-limit table name: ${JSON.stringify(table)}`);
  }
  return table;
}

/**
 * DDL for the table {@link PostgresStore} expects. Run it once, or copy it into
 * your migrations — an app on Prisma or Drizzle should declare the table in its
 * schema instead, or the next migration will see it as drift (see the README).
 */
export function postgresStoreSchema(table = "rate_limits"): string {
  const name = assertTable(table);
  const index = `${name.replace(".", "_")}_reset_at_idx`;
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (`,
    `  key text PRIMARY KEY,`,
    `  count integer NOT NULL,`,
    `  reset_at timestamptz NOT NULL`,
    `);`,
    `CREATE INDEX IF NOT EXISTS ${index} ON ${name} (reset_at);`,
  ].join("\n");
}

/**
 * Distributed fixed-window counter in one Postgres row per key.
 *
 * For apps that already have Postgres and would otherwise run Redis only to
 * share rate-limit counters between instances.
 *
 * Each `hit` is a single upsert, so it is atomic without a transaction and
 * works over HTTP drivers such as Neon's. The window is measured on the
 * database clock, so every instance agrees on when it ends.
 *
 * Rows do not expire on their own: an expired row is reused by the next hit on
 * its key, and the rest are deleted by `cleanup()`.
 */
export class PostgresStore implements RateLimitStore {
  private readonly table: string;
  private readonly onError: "open" | "closed";
  private readonly onErrorLog?: (error: unknown) => void;
  private readonly cleanupIntervalMs: number;
  private lastCleanup = Date.now();

  constructor(
    private readonly query: PostgresQuery,
    options: PostgresStoreOptions = {},
  ) {
    this.table = assertTable(options.table ?? "rate_limits");
    this.onError = options.onError ?? "open";
    this.onErrorLog = options.onErrorLog;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60_000;
  }

  async hit(key: string, windowMs: number): Promise<StoreHit> {
    await this.maybeCleanup();

    const t = this.table;
    // Every SET expression reads the row as it was before the update, so both
    // CASEs see the same, old reset_at. The epoch is cast to float8 because
    // `pg` returns numeric and bigint as strings.
    const text = `
      INSERT INTO ${t} AS r (key, count, reset_at)
      VALUES ($1::text, 1, now() + $2::float8 * interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.count + 1 END,
        reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
      RETURNING count, (extract(epoch FROM reset_at) * 1000)::float8 AS reset_at_ms`;

    try {
      const [row] = await this.query(text, [key, windowMs]);
      if (!row) throw new Error("Rate-limit upsert returned no row");
      return {
        count: Number(row.count),
        resetAt: Math.round(Number(row.reset_at_ms)),
      };
    } catch (error) {
      this.onErrorLog?.(error);
      if (this.onError === "closed") throw error;
      // Fail open: report a first-of-window hit so the caller admits it.
      return { count: 1, resetAt: Date.now() + windowMs };
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
    } catch (error) {
      this.onErrorLog?.(error);
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.query(`DELETE FROM ${this.table} WHERE reset_at <= now()`, []);
    } catch (error) {
      this.onErrorLog?.(error);
    }
  }

  private async maybeCleanup(): Promise<void> {
    if (this.cleanupIntervalMs <= 0) return;
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;
    await this.cleanup();
  }
}
