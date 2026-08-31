/**
 * Rate-limit stores.
 *
 * A store owns one thing: "bump the counter for this key and tell me where the
 * current window stands". The algorithm is a **fixed window** — see the
 * "Fixed window, not sliding" section of the README for why.
 */
/** What a store returns after counting one request against `key`. */
interface StoreHit {
    /** How many requests (including this one) have landed in the current window. */
    count: number;
    /** Epoch ms at which the current window expires. */
    resetAt: number;
}
interface RateLimitStore {
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
declare class MemoryStore implements RateLimitStore {
    private readonly cleanupIntervalMs;
    private entries;
    private lastCleanup;
    /** Milliseconds between opportunistic sweeps of expired keys. */
    constructor(cleanupIntervalMs?: number);
    hit(key: string, windowMs: number): StoreHit;
    reset(key: string): void;
    cleanup(): void;
    /** Number of keys currently tracked. Exposed for tests and diagnostics. */
    get size(): number;
    private maybeCleanup;
}
/**
 * The slice of a Redis client this package needs.
 *
 * Satisfied as-is by `ioredis` and by `@upstash/redis`'s REST client — both
 * expose `incr`, `pexpire`, `pttl` and `del` with these signatures.
 */
interface RedisLike {
    incr(key: string): Promise<number>;
    pexpire(key: string, milliseconds: number): Promise<number | boolean>;
    pttl(key: string): Promise<number>;
    del(key: string): Promise<number | unknown>;
}
interface RedisStoreOptions {
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
declare class RedisStore implements RateLimitStore {
    private readonly redis;
    private readonly prefix;
    private readonly onError;
    private readonly onErrorLog?;
    constructor(redis: RedisLike, options?: RedisStoreOptions);
    hit(key: string, windowMs: number): Promise<StoreHit>;
    reset(key: string): Promise<void>;
    /** No-op: Redis expires the keys itself. */
    cleanup(): void;
}

/**
 * Deriving a rate-limit bucket key from an inbound request.
 *
 * The whole point is that a client must not be able to choose its own bucket.
 * `x-forwarded-for` is a list that proxies APPEND to, so its left-most entry is
 * whatever the caller invented and its right-most entry is the hop your own edge
 * added. Reading `[0]` — the obvious thing — lets anyone mint a fresh bucket per
 * request just by rotating a header.
 */
/**
 * Strip the wrappers a proxy may add (`for=`, quotes, `[v6]`, `:port`) and
 * return the address only if it actually parses as one.
 */
declare function normalizeIpCandidate(value: string): string | null;
interface GetClientIdOptions {
    /**
     * Cookie names to fall back to when no trustworthy IP is available, so
     * unidentified callers get their own bucket instead of sharing one global
     * `"anonymous"` bucket any single client could exhaust for everyone.
     */
    sessionCookieNames?: string[];
    /**
     * Last resort when there is no IP and no session cookie. `"fingerprint"`
     * (default) hashes UA + accept headers; `"anonymous"` returns a shared bucket.
     */
    fallback?: "fingerprint" | "anonymous";
}
/**
 * Best available client identifier, most trustworthy source first.
 *
 * Works with any `Request` — a `NextRequest` is one.
 */
declare function getClientId(request: Request, options?: GetClientIdOptions): string;

/**
 * `@gr8monk3ys/next-kit/rate-limit`
 *
 * One fixed-window limiter with a pluggable store, plus the request-handler
 * glue every app in the fleet had rewritten.
 */

interface RateLimitResult {
    /** Whether the request is admitted. */
    ok: boolean;
    /** The configured ceiling, echoed back for headers. */
    limit: number;
    /** Requests left in the current window. Never negative. */
    remaining: number;
    /** Epoch ms at which the current window expires. */
    resetAt: number;
    /** Seconds until the window expires. Present only when `ok` is false. */
    retryAfter?: number;
}
interface RateLimiterOptions {
    /** Where counters live. Default: a process-local `MemoryStore`. */
    store?: RateLimitStore;
    /** Maximum requests admitted per window. */
    limit: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /**
     * Turns a request into a bucket key. Default: {@link getClientId}.
     * Only used by `checkRequest` / `withRateLimit`.
     */
    keyFn?: (request: Request) => string | Promise<string>;
    /**
     * Namespace prepended to every key, so two limiters sharing a store do not
     * share buckets (e.g. `"auth"`, `"ai-search"`).
     */
    prefix?: string;
}
interface RateLimiter {
    /** Count one request against `key` and say whether it is admitted. */
    check(key: string): Promise<RateLimitResult>;
    /** Count one request against the key `keyFn` derives from `request`. */
    checkRequest(request: Request): Promise<RateLimitResult>;
    /** Forget everything recorded for `key`. */
    reset(key: string): Promise<void>;
    /** Drop expired entries in the underlying store. */
    cleanup(): Promise<void>;
    readonly limit: number;
    readonly windowMs: number;
}
/**
 * Build a limiter.
 *
 * ```ts
 * const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, prefix: "ai" });
 * const { ok, remaining, resetAt } = await limiter.check(userId);
 * ```
 */
declare function createRateLimiter(options: RateLimiterOptions): RateLimiter;
/** `X-RateLimit-*` headers for a result, plus `Retry-After` when blocked. */
declare function rateLimitHeaders(result: RateLimitResult): Record<string, string>;
/** The 429 every app in the fleet hand-wrote, with the headers attached. */
declare function rateLimitExceededResponse(result: RateLimitResult, message?: string): Response;
/** Copy the `X-RateLimit-*` headers onto a response you are already returning. */
declare function addRateLimitHeaders<T extends Response>(response: T, result: RateLimitResult): T;
interface WithRateLimitOptions extends RateLimiterOptions {
    /** Reuse an existing limiter instead of building one from the other fields. */
    limiter?: RateLimiter;
    /** Response to return when the limit is hit. Default: a 429 JSON body. */
    onLimit?: (request: Request, result: RateLimitResult) => Response | Promise<Response>;
    /** Add `X-RateLimit-*` headers to admitted responses too. Default `true`. */
    setHeaders?: boolean;
}
type Handler<Args extends unknown[]> = (request: Request, ...args: Args) => Response | Promise<Response>;
/**
 * Wrap a route handler (or middleware) so it is rate limited.
 *
 * ```ts
 * export const POST = withRateLimit(handler, { limit: 5, windowMs: 60_000 });
 * ```
 *
 * The wrapper is generic over the handler's trailing arguments, so Next.js
 * route handlers keep their `{ params }` context.
 */
declare function withRateLimit<Args extends unknown[]>(handler: Handler<Args>, options: WithRateLimitOptions | {
    limiter: RateLimiter;
} & Partial<WithRateLimitOptions>): Handler<Args>;

export { type GetClientIdOptions, MemoryStore, type RateLimitResult, type RateLimitStore, type RateLimiter, type RateLimiterOptions, type RedisLike, RedisStore, type RedisStoreOptions, type StoreHit, type WithRateLimitOptions, addRateLimitHeaders, createRateLimiter, getClientId, normalizeIpCandidate, rateLimitExceededResponse, rateLimitHeaders, withRateLimit };
