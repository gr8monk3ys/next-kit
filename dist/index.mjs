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

// src/rate-limit/client-id.ts
var TRUSTED_SINGLE_VALUE_HEADERS = [
  "x-vercel-forwarded-for",
  // Vercel
  "cf-connecting-ip",
  // Cloudflare
  "x-real-ip"
  // nginx / Vercel
];
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
function getClientId(request, options = {}) {
  for (const header of TRUSTED_SINGLE_VALUE_HEADERS) {
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
  return {
    limit,
    windowMs,
    async check(key) {
      return toResult(await store.hit(namespaced(key), windowMs));
    },
    async checkRequest(request) {
      return this.check(await keyFn(request));
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

// src/auth/clerk.ts
var clerkModule = null;
var clerkModulePromise = null;
function setClerkModule(module) {
  clerkModule = module;
  clerkModulePromise = null;
}
async function loadClerk() {
  if (clerkModule) return clerkModule;
  if (!clerkModulePromise) {
    const specifier = "@clerk/nextjs/server";
    clerkModulePromise = import(specifier).then((mod) => mod).catch(() => null);
  }
  return clerkModulePromise;
}
function isClerkConfigured() {
  return Boolean(
    process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  );
}
async function getClerkAuth() {
  const mod = await loadClerk();
  if (!mod) return null;
  try {
    return await mod.auth();
  } catch {
    return null;
  }
}
async function getClerkUserId() {
  const session = await getClerkAuth();
  return session?.userId ?? null;
}
async function isAuthenticated() {
  return await getClerkUserId() !== null;
}
var UnauthorizedError = class extends Error {
  status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
};
var ForbiddenError = class extends Error {
  status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
};
async function requireClerkUserId() {
  const userId = await getClerkUserId();
  if (!userId) throw new UnauthorizedError();
  return userId;
}
function defaultGetRole(user) {
  if (user && typeof user === "object" && "role" in user) {
    const role = user.role;
    return typeof role === "string" ? role : null;
  }
  return null;
}
function createClerkAuth(options) {
  const getRole = options.getRole ?? defaultGetRole;
  async function getUserOrNull() {
    if (options.fallback && await options.fallback.enabled()) {
      const fallbackUser = await options.fallback.resolve();
      if (fallbackUser) return fallbackUser;
    }
    const clerkUserId = await getClerkUserId();
    if (!clerkUserId) return null;
    return await options.resolveUser(clerkUserId) ?? null;
  }
  async function requireUser() {
    const user = await getUserOrNull();
    if (!user) throw new UnauthorizedError();
    return user;
  }
  async function hasRole(roles) {
    const user = await getUserOrNull();
    if (!user) return false;
    const role = getRole(user);
    if (!role) return false;
    return (Array.isArray(roles) ? roles : [roles]).includes(role);
  }
  async function requireRole(roles) {
    const user = await requireUser();
    const role = getRole(user);
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!role || !allowed.includes(role)) {
      throw new ForbiddenError(
        `Requires one of: ${allowed.join(", ")}`
      );
    }
    return user;
  }
  return { getUserOrNull, requireUser, hasRole, requireRole };
}
function authErrorResponse(error) {
  if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
    return new Response(
      JSON.stringify({ error: error.message, statusCode: error.status }),
      { status: error.status, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}

export { ForbiddenError, MemoryStore, RedisStore, UnauthorizedError, addRateLimitHeaders, authErrorResponse, createClerkAuth, createRateLimiter, getClerkAuth, getClerkUserId, getClientId, isAuthenticated, isClerkConfigured, normalizeIpCandidate, rateLimitExceededResponse, rateLimitHeaders, requireClerkUserId, setClerkModule, withRateLimit };
