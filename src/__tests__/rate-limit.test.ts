import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  createRateLimiter,
  MemoryStore,
  RedisStore,
  getClientId,
  normalizeIpCandidate,
  rateLimitHeaders,
  rateLimitExceededResponse,
  addRateLimitHeaders,
  withRateLimit,
  type RedisLike,
} from "../rate-limit/index";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/thing", { headers });
}

describe("MemoryStore", () => {
  it("admits exactly `limit` requests, then blocks", async () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await limiter.check("ip-1"));

    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
  });

  it("keeps separate buckets per key", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

    expect((await limiter.check("a")).ok).toBe(true);
    expect((await limiter.check("b")).ok).toBe(true);
    expect((await limiter.check("a")).ok).toBe(false);
  });

  it("namespaces by prefix so two limiters do not share a bucket", async () => {
    const store = new MemoryStore();
    const auth = createRateLimiter({ store, limit: 1, windowMs: 60_000, prefix: "auth" });
    const search = createRateLimiter({ store, limit: 1, windowMs: 60_000, prefix: "search" });

    expect((await auth.check("ip")).ok).toBe(true);
    expect((await search.check("ip")).ok).toBe(true);
    expect((await auth.check("ip")).ok).toBe(false);
  });

  it("reset() clears a key", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect((await limiter.check("k")).ok).toBe(true);
    expect((await limiter.check("k")).ok).toBe(false);

    await limiter.reset("k");
    expect((await limiter.check("k")).ok).toBe(true);
  });

  it("survives being destructured off the limiter", async () => {
    // `const { checkRequest } = limiter` is a natural thing to write. A method
    // body calling `this.check(...)` would throw "Cannot read properties of
    // undefined" here.
    const { check, checkRequest, reset } = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
    });

    expect((await check("k")).ok).toBe(true);
    expect((await check("k")).ok).toBe(false);
    await reset("k");

    const request = new Request("https://example.test/", {
      headers: { "x-real-ip": "9.9.9.9" },
    });
    expect((await checkRequest(request)).ok).toBe(true);
    expect((await checkRequest(request)).ok).toBe(false);
  });

  it("rejects a non-positive limit or window", () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1000 })).toThrow(TypeError);
    expect(() => createRateLimiter({ limit: 5, windowMs: 0 })).toThrow(TypeError);
  });
});

describe("window rollover (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a fresh window once resetAt has passed", async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });

    expect((await limiter.check("k")).ok).toBe(true);
    expect((await limiter.check("k")).ok).toBe(true);
    const blocked = await limiter.check("k");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBe(60);

    // One millisecond short of the boundary: still blocked.
    vi.advanceTimersByTime(59_999);
    expect((await limiter.check("k")).ok).toBe(false);

    // Boundary reached: the window rolls over.
    vi.advanceTimersByTime(1);
    const rolled = await limiter.check("k");
    expect(rolled.ok).toBe(true);
    expect(rolled.remaining).toBe(1);
    expect(rolled.resetAt).toBe(Date.now() + 60_000);
  });

  it("retryAfter shrinks as the window drains", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    await limiter.check("k");

    expect((await limiter.check("k")).retryAfter).toBe(60);
    vi.advanceTimersByTime(30_000);
    expect((await limiter.check("k")).retryAfter).toBe(30);
  });

  it("cleanup() drops only expired entries", async () => {
    const store = new MemoryStore();
    store.hit("old", 1_000);
    vi.advanceTimersByTime(500);
    store.hit("new", 10_000);
    vi.advanceTimersByTime(600); // "old" has expired, "new" has not

    expect(store.size).toBe(2);
    store.cleanup();
    expect(store.size).toBe(1);
  });
});

/** A minimal fake standing in for ioredis / @upstash/redis. */
function fakeRedis(): RedisLike & { store: Map<string, { value: number; expiresAt: number | null }> } {
  const store = new Map<string, { value: number; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    store,
    async incr(key) {
      const entry = live(key);
      if (!entry) {
        store.set(key, { value: 1, expiresAt: null });
        return 1;
      }
      entry.value += 1;
      return entry.value;
    },
    async pexpire(key, ms) {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + ms;
      return 1;
    },
    async pttl(key) {
      const entry = live(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return entry.expiresAt - Date.now();
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

describe("RedisStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts across calls and expires the key with the window", async () => {
    const redis = fakeRedis();
    const limiter = createRateLimiter({
      store: new RedisStore(redis),
      limit: 2,
      windowMs: 10_000,
    });

    expect((await limiter.check("ip")).ok).toBe(true);
    expect((await limiter.check("ip")).ok).toBe(true);
    expect((await limiter.check("ip")).ok).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect((await limiter.check("ip")).ok).toBe(true);
  });

  it("sets the TTL on the first request only", async () => {
    const redis = fakeRedis();
    const pexpire = vi.spyOn(redis, "pexpire");
    const store = new RedisStore(redis);

    await store.hit("k", 5_000);
    await store.hit("k", 5_000);
    await store.hit("k", 5_000);

    expect(pexpire).toHaveBeenCalledTimes(1);
  });

  it("derives resetAt from PTTL rather than re-adding the window", async () => {
    const redis = fakeRedis();
    const store = new RedisStore(redis);

    const first = await store.hit("k", 10_000);
    vi.advanceTimersByTime(4_000);
    const second = await store.hit("k", 10_000);

    expect(second.resetAt).toBe(first.resetAt);
  });

  it("re-arms a key that somehow lost its TTL", async () => {
    const redis = fakeRedis();
    const store = new RedisStore(redis);

    await redis.incr("ratelimit:k"); // count 1 with no TTL
    const hit = await store.hit("k", 5_000);

    expect(hit.count).toBe(2);
    expect(await redis.pttl("ratelimit:k")).toBeGreaterThan(0);
  });

  it("applies the key prefix", async () => {
    const redis = fakeRedis();
    await new RedisStore(redis, { prefix: "rl:app:" }).hit("k", 1_000);
    expect([...redis.store.keys()]).toEqual(["rl:app:k"]);
  });

  it("fails open when Redis throws, and reports the error", async () => {
    const onErrorLog = vi.fn();
    const broken: RedisLike = {
      incr: () => Promise.reject(new Error("ECONNREFUSED")),
      pexpire: async () => 1,
      pttl: async () => -2,
      del: async () => 0,
    };
    const limiter = createRateLimiter({
      store: new RedisStore(broken, { onErrorLog }),
      limit: 1,
      windowMs: 1_000,
    });

    expect((await limiter.check("k")).ok).toBe(true);
    expect((await limiter.check("k")).ok).toBe(true);
    expect(onErrorLog).toHaveBeenCalledTimes(2);
  });

  it("fails closed when told to", async () => {
    const broken: RedisLike = {
      incr: () => Promise.reject(new Error("ECONNREFUSED")),
      pexpire: async () => 1,
      pttl: async () => -2,
      del: async () => 0,
    };
    const store = new RedisStore(broken, { onError: "closed" });
    await expect(store.hit("k", 1_000)).rejects.toThrow("ECONNREFUSED");
  });
});

describe("getClientId", () => {
  it("prefers a DECLARED platform header over x-forwarded-for", () => {
    expect(
      getClientId(
        request({ "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "9.9.9.9" }),
        { platform: "vercel" },
      ),
    ).toBe("1.1.1.1");
    expect(
      getClientId(request({ "cf-connecting-ip": "2.2.2.2" }), {
        platform: "cloudflare",
      }),
    ).toBe("2.2.2.2");
  });

  it("prefers x-real-ip over x-forwarded-for with no platform declared", () => {
    expect(
      getClientId(request({ "x-real-ip": "5.5.5.5", "x-forwarded-for": "9.9.9.9" })),
    ).toBe("5.5.5.5");
  });

  // The bug this default exists to prevent: off Cloudflare, nothing strips an
  // inbound cf-connecting-ip, so trusting it by default hands every caller a
  // fresh rate-limit bucket per request.
  it("does NOT trust cf-connecting-ip by default", () => {
    const honest = request({ "x-forwarded-for": "9.9.9.9" });
    const spoofed = request({
      "cf-connecting-ip": "6.6.6.6",
      "x-forwarded-for": "9.9.9.9",
    });
    const spoofedAgain = request({
      "cf-connecting-ip": "7.7.7.7",
      "x-forwarded-for": "9.9.9.9",
    });

    expect(getClientId(honest)).toBe("9.9.9.9");
    expect(getClientId(spoofed)).toBe("9.9.9.9");
    expect(getClientId(spoofedAgain)).toBe("9.9.9.9");
  });

  it("does NOT trust x-vercel-forwarded-for unless vercel is declared", () => {
    const req = request({
      "x-vercel-forwarded-for": "6.6.6.6",
      "x-real-ip": "5.5.5.5",
    });
    expect(getClientId(req)).toBe("5.5.5.5");
    expect(getClientId(req, { platform: "generic" })).toBe("5.5.5.5");
    expect(getClientId(req, { platform: "vercel" })).toBe("6.6.6.6");
  });

  it("a lone spoofed cf-connecting-ip does not mint a bucket by default", () => {
    // No trustworthy source at all -> the fingerprint/anonymous fallback,
    // which the attacker cannot rotate per request by changing one header.
    expect(getClientId(request({ "cf-connecting-ip": "6.6.6.6" }))).toBe(
      getClientId(request({ "cf-connecting-ip": "7.7.7.7" })),
    );
    expect(
      getClientId(request({ "cf-connecting-ip": "6.6.6.6" }), {
        fallback: "anonymous",
      }),
    ).toBe("anonymous");
  });

  it("trustedHeaders replaces the platform + default list entirely", () => {
    const req = request({
      "true-client-ip": "8.8.8.8",
      "x-real-ip": "5.5.5.5",
      "cf-connecting-ip": "6.6.6.6",
    });
    expect(getClientId(req, { trustedHeaders: ["true-client-ip"] })).toBe("8.8.8.8");
    // x-real-ip is NOT appended for free: an explicit list is the whole list.
    expect(
      getClientId(request({ "x-real-ip": "5.5.5.5", "x-forwarded-for": "9.9.9.9" }), {
        trustedHeaders: ["true-client-ip"],
      }),
    ).toBe("9.9.9.9");
    // ...and declaring cloudflare does not re-admit cf-connecting-ip here.
    expect(
      getClientId(req, {
        platform: "cloudflare",
        trustedHeaders: ["true-client-ip"],
      }),
    ).toBe("8.8.8.8");
  });

  it("takes the RIGHT-most x-forwarded-for entry, not the client-supplied left", () => {
    // A caller can prepend anything; only the last hop was appended by our edge.
    expect(getClientId(request({ "x-forwarded-for": "6.6.6.6, 10.0.0.1, 3.3.3.3" }))).toBe(
      "3.3.3.3",
    );
  });

  it("falls back to a session cookie, then a fingerprint", () => {
    const withCookie = request({ cookie: "__session=abc123; other=1" });
    const id = getClientId(withCookie, { sessionCookieNames: ["__session"] });
    expect(id.startsWith("session:")).toBe(true);

    const anonymous = getClientId(request({ "user-agent": "curl/8" }));
    expect(anonymous.startsWith("fingerprint:")).toBe(true);

    expect(getClientId(request(), { fallback: "anonymous" })).toBe("anonymous");
  });

  it("gives different fingerprints to different clients", () => {
    expect(getClientId(request({ "user-agent": "a" }))).not.toBe(
      getClientId(request({ "user-agent": "b" })),
    );
  });

  it("normalizes proxy wrappers and rejects non-addresses", () => {
    expect(normalizeIpCandidate('for="1.2.3.4"')).toBe("1.2.3.4");
    expect(normalizeIpCandidate("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIpCandidate("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(normalizeIpCandidate("999.1.1.1")).toBeNull();
    expect(normalizeIpCandidate("not-an-ip")).toBeNull();
  });
});

describe("responses", () => {
  it("rateLimitHeaders omits Retry-After while under the limit", async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const ok = await limiter.check("k");
    expect(rateLimitHeaders(ok)).not.toHaveProperty("Retry-After");
    expect(rateLimitHeaders(ok)["X-RateLimit-Remaining"]).toBe("1");
  });

  it("rateLimitExceededResponse is a 429 with the standard headers", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    await limiter.check("k");
    const blocked = await limiter.check("k");

    const response = rateLimitExceededResponse(blocked);
    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(response.headers.get("Retry-After")).toBe(String(blocked.retryAfter));
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "RATE_LIMIT_EXCEEDED", statusCode: 429 },
    });
  });

  it("addRateLimitHeaders decorates an existing response", async () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
    const result = await limiter.check("k");
    const response = addRateLimitHeaders(new Response("hi"), result);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("4");
  });
});

describe("withRateLimit", () => {
  it("passes through, then 429s once the limit is hit", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const guarded = withRateLimit(handler, { limit: 2, windowMs: 60_000 });
    const req = () => request({ "x-real-ip": "5.5.5.5" });

    expect((await guarded(req())).status).toBe(200);
    expect((await guarded(req())).status).toBe(200);

    const blocked = await guarded(req());
    expect(blocked.status).toBe(429);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("adds headers to successful responses", async () => {
    const guarded = withRateLimit(async () => new Response("ok"), {
      limit: 10,
      windowMs: 60_000,
    });
    const response = await guarded(request({ "x-real-ip": "6.6.6.6" }));
    expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("9");
  });

  it("honours a custom keyFn, so buckets can be per-user", async () => {
    const guarded = withRateLimit(async () => new Response("ok"), {
      limit: 1,
      windowMs: 60_000,
      keyFn: (r) => r.headers.get("x-user-id") ?? "anon",
    });

    expect((await guarded(request({ "x-user-id": "u1" }))).status).toBe(200);
    expect((await guarded(request({ "x-user-id": "u2" }))).status).toBe(200);
    expect((await guarded(request({ "x-user-id": "u1" }))).status).toBe(429);
  });

  it("honours a custom onLimit response", async () => {
    const guarded = withRateLimit(async () => new Response("ok"), {
      limit: 1,
      windowMs: 60_000,
      onLimit: () => new Response("slow down", { status: 503 }),
    });
    await guarded(request({ "x-real-ip": "7.7.7.7" }));
    expect((await guarded(request({ "x-real-ip": "7.7.7.7" }))).status).toBe(503);
  });

  it("forwards the handler's extra arguments (Next.js route context)", async () => {
    const handler = vi.fn(async (_r: Request, ctx: { params: { id: string } }) =>
      Response.json(ctx.params),
    );
    const guarded = withRateLimit(handler, { limit: 5, windowMs: 60_000 });

    const response = await guarded(request({ "x-real-ip": "8.8.8.8" }), {
      params: { id: "42" },
    });
    await expect(response.json()).resolves.toEqual({ id: "42" });
  });

  it("reuses a shared limiter when given one", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const a = withRateLimit(async () => new Response("a"), { limiter });
    const b = withRateLimit(async () => new Response("b"), { limiter });

    expect((await a(request({ "x-real-ip": "4.4.4.4" }))).status).toBe(200);
    expect((await b(request({ "x-real-ip": "4.4.4.4" }))).status).toBe(429);
  });
});
