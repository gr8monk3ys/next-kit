// src/rate-limit/store.ts
var MemoryStore = class {
  /** Milliseconds between opportunistic sweeps of expired keys. */
  constructor(cleanupIntervalMs = 6e4) {
    this.cleanupIntervalMs = cleanupIntervalMs;
  }
  cleanupIntervalMs;
  entries = /* @__PURE__ */ new Map();
  lastCleanup = 0;
  hit(key, windowMs) {
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
  reset(key) {
    this.entries.delete(key);
  }
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) this.entries.delete(key);
    }
  }
  /** Number of keys currently tracked. Exposed for tests and diagnostics. */
  get size() {
    return this.entries.size;
  }
  maybeCleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;
    this.cleanup();
  }
};
var RedisStore = class {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.prefix = options.prefix ?? "ratelimit:";
    this.onError = options.onError ?? "open";
    this.onErrorLog = options.onErrorLog;
  }
  redis;
  prefix;
  onError;
  onErrorLog;
  async hit(key, windowMs) {
    const redisKey = `${this.prefix}${key}`;
    const now = Date.now();
    try {
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.pexpire(redisKey, windowMs);
        return { count, resetAt: now + windowMs };
      }
      const ttl = await this.redis.pttl(redisKey);
      if (ttl < 0) {
        await this.redis.pexpire(redisKey, windowMs);
        return { count, resetAt: now + windowMs };
      }
      return { count, resetAt: now + ttl };
    } catch (error) {
      this.onErrorLog?.(error);
      if (this.onError === "closed") throw error;
      return { count: 1, resetAt: now + windowMs };
    }
  }
  async reset(key) {
    try {
      await this.redis.del(`${this.prefix}${key}`);
    } catch (error) {
      this.onErrorLog?.(error);
    }
  }
  /** No-op: Redis expires the keys itself. */
  cleanup() {
  }
};
var IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
function assertTable(table) {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`Invalid rate-limit table name: ${JSON.stringify(table)}`);
  }
  return table;
}
function postgresStoreSchema(table = "rate_limits") {
  const name = assertTable(table);
  const index = `${name.replace(".", "_")}_reset_at_idx`;
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (`,
    `  key text PRIMARY KEY,`,
    `  count integer NOT NULL,`,
    `  reset_at timestamptz NOT NULL`,
    `);`,
    `CREATE INDEX IF NOT EXISTS ${index} ON ${name} (reset_at);`
  ].join("\n");
}
var PostgresStore = class {
  constructor(query, options = {}) {
    this.query = query;
    this.table = assertTable(options.table ?? "rate_limits");
    this.onError = options.onError ?? "open";
    this.onErrorLog = options.onErrorLog;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 6e4;
  }
  query;
  table;
  onError;
  onErrorLog;
  cleanupIntervalMs;
  lastCleanup = Date.now();
  async hit(key, windowMs) {
    await this.maybeCleanup();
    const t = this.table;
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
        resetAt: Math.round(Number(row.reset_at_ms))
      };
    } catch (error) {
      this.onErrorLog?.(error);
      if (this.onError === "closed") throw error;
      return { count: 1, resetAt: Date.now() + windowMs };
    }
  }
  async reset(key) {
    try {
      await this.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
    } catch (error) {
      this.onErrorLog?.(error);
    }
  }
  async cleanup() {
    try {
      await this.query(`DELETE FROM ${this.table} WHERE reset_at <= now()`, []);
    } catch (error) {
      this.onErrorLog?.(error);
    }
  }
  async maybeCleanup() {
    if (this.cleanupIntervalMs <= 0) return;
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;
    await this.cleanup();
  }
};

// src/rate-limit/client-id.ts
var PLATFORM_HEADERS = {
  vercel: ["x-vercel-forwarded-for"],
  cloudflare: ["cf-connecting-ip"],
  generic: []
};
var DEFAULT_TRUSTED_HEADERS = ["x-real-ip"];
function isValidIpv4(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  return value.split(".").every((segment) => {
    const num = Number(segment);
    return num >= 0 && num <= 255;
  });
}
function isValidIpv6(value) {
  return /^[a-f0-9:]+$/i.test(value) && value.includes(":");
}
function normalizeIpCandidate(value) {
  let candidate = value.trim();
  if (!candidate) return null;
  if (candidate.toLowerCase().startsWith("for=")) {
    candidate = candidate.slice(4).trim();
  }
  candidate = candidate.replace(/^"|"$/g, "");
  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.replace(/:\d+$/, "");
  }
  if (isValidIpv4(candidate) || isValidIpv6(candidate)) return candidate;
  return null;
}
function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
  }
  return (hash >>> 0).toString(36);
}
function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const entry of header.split(";")) {
    const [rawName, ...rest] = entry.trim().split("=");
    if (rawName === name && rest.length > 0) return rest.join("=");
  }
  return null;
}
function trustedHeadersFor(options) {
  if (options.trustedHeaders) return options.trustedHeaders;
  return [
    ...PLATFORM_HEADERS[options.platform ?? "generic"],
    ...DEFAULT_TRUSTED_HEADERS
  ];
}
function getClientId(request, options = {}) {
  for (const header of trustedHeadersFor(options)) {
    const value = request.headers.get(header);
    if (!value) continue;
    const ip = normalizeIpCandidate(value.split(",")[0] ?? value);
    if (ip) return ip;
  }
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor.split(",").map((v) => v.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) {
      const ip = normalizeIpCandidate(last);
      if (ip) return ip;
    }
  }
  for (const name of options.sessionCookieNames ?? []) {
    const value = readCookie(request, name);
    if (value) return `session:${hashString(`${name}:${value}`)}`;
  }
  if (options.fallback === "anonymous") return "anonymous";
  const fingerprint = [
    request.headers.get("user-agent") ?? "",
    request.headers.get("accept-language") ?? "",
    request.headers.get("accept-encoding") ?? ""
  ].join(":");
  return `fingerprint:${hashString(fingerprint)}`;
}

// src/rate-limit/index.ts
function createRateLimiter(options) {
  const {
    store = new MemoryStore(),
    limit,
    windowMs,
    keyFn = (request) => getClientId(request),
    prefix
  } = options;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError(`createRateLimiter: limit must be > 0, got ${limit}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError(
      `createRateLimiter: windowMs must be > 0, got ${windowMs}`
    );
  }
  const namespaced = (key) => prefix ? `${prefix}:${key}` : key;
  const toResult = (hit) => {
    const ok = hit.count <= limit;
    const result = {
      ok,
      limit,
      remaining: Math.max(0, limit - hit.count),
      resetAt: hit.resetAt
    };
    if (!ok) {
      result.retryAfter = Math.max(
        0,
        Math.ceil((hit.resetAt - Date.now()) / 1e3)
      );
    }
    return result;
  };
  const check = async (key) => toResult(await store.hit(namespaced(key), windowMs));
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
    }
  };
}
function rateLimitHeaders(result) {
  const headers = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt)
  };
  if (!result.ok) {
    headers["Retry-After"] = String(result.retryAfter ?? 60);
  }
  return headers;
}
function rateLimitExceededResponse(result, message = "Too many requests. Please try again later.") {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message,
        statusCode: 429,
        retryAfter: result.retryAfter
      }
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json", ...rateLimitHeaders(result) }
    }
  );
}
function addRateLimitHeaders(response, result) {
  for (const [name, value] of Object.entries(rateLimitHeaders(result))) {
    response.headers.set(name, value);
  }
  return response;
}
function withRateLimit(handler, options) {
  const opts = options;
  const limiter = opts.limiter ?? createRateLimiter({
    store: opts.store,
    limit: opts.limit,
    windowMs: opts.windowMs,
    keyFn: opts.keyFn,
    prefix: opts.prefix
  });
  const setHeaders = opts.setHeaders ?? true;
  return async (request, ...args) => {
    const result = await limiter.checkRequest(request);
    if (!result.ok) {
      const response2 = opts.onLimit ? await opts.onLimit(request, result) : rateLimitExceededResponse(result);
      return setHeaders ? addRateLimitHeaders(response2, result) : response2;
    }
    const response = await handler(request, ...args);
    return setHeaders ? addRateLimitHeaders(response, result) : response;
  };
}

export { MemoryStore, PostgresStore, RedisStore, addRateLimitHeaders, createRateLimiter, getClientId, normalizeIpCandidate, postgresStoreSchema, rateLimitExceededResponse, rateLimitHeaders, withRateLimit };
