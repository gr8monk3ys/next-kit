/**
 * `@gr8monk3ys/next-kit/rate-limit`
 *
 * One fixed-window limiter with a pluggable store, plus the request-handler
 * glue that otherwise gets rewritten in every app.
 */

import {
  MemoryStore,
  RedisStore,
  type RateLimitStore,
  type RedisLike,
  type RedisStoreOptions,
  type StoreHit,
} from "./store";
import { getClientId, type GetClientIdOptions } from "./client-id";

export { MemoryStore, RedisStore } from "./store";
export { getClientId, normalizeIpCandidate } from "./client-id";

export interface RateLimitResult {
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

export interface RateLimiterOptions {
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

export interface RateLimiter {
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
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const {
    store = new MemoryStore(),
    limit,
    windowMs,
    keyFn = (request: Request) => getClientId(request),
    prefix,
  } = options;

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError(`createRateLimiter: limit must be > 0, got ${limit}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError(
      `createRateLimiter: windowMs must be > 0, got ${windowMs}`,
    );
  }

  const namespaced = (key: string) => (prefix ? `${prefix}:${key}` : key);

  const toResult = (hit: StoreHit): RateLimitResult => {
    const ok = hit.count <= limit;
    const result: RateLimitResult = {
      ok,
      limit,
      remaining: Math.max(0, limit - hit.count),
      resetAt: hit.resetAt,
    };
    if (!ok) {
      result.retryAfter = Math.max(
        0,
        Math.ceil((hit.resetAt - Date.now()) / 1000),
      );
    }
    return result;
  };

  // Closures, not methods: `const { checkRequest } = limiter` is a natural
  // thing to write, and a `this.check(...)` call would throw once detached.
  const check = async (key: string): Promise<RateLimitResult> =>
    toResult(await store.hit(namespaced(key), windowMs));

  return {
    limit,
    windowMs,
    check,
    async checkRequest(request) {
      return check(await keyFn(request));
    },
    async reset(key) {
      await store.reset(namespaced(key));
    },
    async cleanup() {
      await store.cleanup();
    },
  };
}

/** `X-RateLimit-*` headers for a result, plus `Retry-After` when blocked. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
  };
  if (!result.ok) {
    headers["Retry-After"] = String(result.retryAfter ?? 60);
  }
  return headers;
}

/** The standard 429 body, with the rate-limit headers attached. */
export function rateLimitExceededResponse(
  result: RateLimitResult,
  message = "Too many requests. Please try again later.",
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message,
        statusCode: 429,
        retryAfter: result.retryAfter,
      },
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json", ...rateLimitHeaders(result) },
    },
  );
}

/** Copy the `X-RateLimit-*` headers onto a response you are already returning. */
export function addRateLimitHeaders<T extends Response>(
  response: T,
  result: RateLimitResult,
): T {
  for (const [name, value] of Object.entries(rateLimitHeaders(result))) {
    response.headers.set(name, value);
  }
  return response;
}

export interface WithRateLimitOptions extends RateLimiterOptions {
  /** Reuse an existing limiter instead of building one from the other fields. */
  limiter?: RateLimiter;
  /** Response to return when the limit is hit. Default: a 429 JSON body. */
  onLimit?: (
    request: Request,
    result: RateLimitResult,
  ) => Response | Promise<Response>;
  /** Add `X-RateLimit-*` headers to admitted responses too. Default `true`. */
  setHeaders?: boolean;
}

type Handler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

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
export function withRateLimit<Args extends unknown[]>(
  handler: Handler<Args>,
  options: WithRateLimitOptions | { limiter: RateLimiter } & Partial<WithRateLimitOptions>,
): Handler<Args> {
  const opts = options as WithRateLimitOptions;
  const limiter =
    opts.limiter ??
    createRateLimiter({
      store: opts.store,
      limit: opts.limit,
      windowMs: opts.windowMs,
      keyFn: opts.keyFn,
      prefix: opts.prefix,
    });
  const setHeaders = opts.setHeaders ?? true;

  return async (request: Request, ...args: Args) => {
    const result = await limiter.checkRequest(request);

    if (!result.ok) {
      const response = opts.onLimit
        ? await opts.onLimit(request, result)
        : rateLimitExceededResponse(result);
      return setHeaders ? addRateLimitHeaders(response, result) : response;
    }

    const response = await handler(request, ...args);
    return setHeaders ? addRateLimitHeaders(response, result) : response;
  };
}

export type {
  RateLimitStore,
  StoreHit,
  RedisLike,
  RedisStoreOptions,
  GetClientIdOptions,
};
