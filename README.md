# @gr8monk3ys/next-kit

Server-side building blocks for Next.js apps, extracted from implementations
that had been rewritten once per project: rate limiting, Stripe, and Clerk auth
guards.

Every export is framework-neutral where it can be — the rate limiter and the
auth guards speak the Web `Request`/`Response` types, which `NextRequest` and
`NextResponse` already are — so the same code runs in a route handler, in
`middleware.ts`, or in a plain test.

## Install

The package is distributed as a GitHub release tarball, pinned to a tag:

```json
{
  "dependencies": {
    "@gr8monk3ys/next-kit": "https://github.com/gr8monk3ys/next-kit/archive/refs/tags/v0.1.1.tar.gz"
  }
}
```

Then, in `next.config.*`:

```js
transpilePackages: ["@gr8monk3ys/next-kit"],
```

That line is required. The `import` condition points at the package's
TypeScript source (`src/`), which is what lets an app's own tooling compile it;
`transpilePackages` is how you tell Next.js to do so. The `require` condition
resolves to the compiled `dist/`, so CommonJS consumers — Jest, for one — need
no configuration at all.

Peer dependencies are all optional. Install only the ones for the subpaths you
import: `stripe` for `/stripe`, `@clerk/nextjs` for `/auth/clerk`. The rate
limiter needs nothing.

## `@gr8monk3ys/next-kit/rate-limit`

```ts
import {
  createRateLimiter,
  MemoryStore,
  RedisStore,
  withRateLimit,
  rateLimitExceededResponse,
} from "@gr8monk3ys/next-kit/rate-limit";

// One limiter, checked by hand.
const aiSearch = createRateLimiter({ limit: 10, windowMs: 60_000, prefix: "ai-search" });

export async function POST(request: Request) {
  const result = await aiSearch.checkRequest(request);
  if (!result.ok) return rateLimitExceededResponse(result);
  // ...
}

// Or wrapped, which is the same thing with the boilerplate removed.
export const GET = withRateLimit(
  async (request: Request) => Response.json({ ok: true }),
  { limit: 60, windowMs: 60_000, prefix: "general" },
);
```

`check(key)` returns `{ ok, limit, remaining, resetAt, retryAfter? }`.
`retryAfter` (seconds) is present only when the request was blocked.

### Stores

`MemoryStore` (the default) is a per-process counter. It does not survive a
restart and it does not coordinate across instances — acceptable as a
degraded-but-still-protective fallback, which is exactly the role it played in
every app this was lifted from.

`RedisStore` takes any client with `incr`, `pexpire`, `pttl` and `del`. That
signature is satisfied as-is by both `ioredis` and `@upstash/redis`'s REST
client:

```ts
import { Redis } from "@upstash/redis";
import { createRateLimiter, RedisStore, MemoryStore } from "@gr8monk3ys/next-kit/rate-limit";

const configured = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;

const limiter = createRateLimiter({
  store: configured
    ? new RedisStore(Redis.fromEnv(), { prefix: "myapp:ratelimit:", onErrorLog: console.error })
    : new MemoryStore(),
  limit: 30,
  windowMs: 60_000,
});
```

`RedisStore` fails **open** by default: a Redis outage must not turn every
request into a 500. Pass `onError: "closed"` to invert that.

### Fixed window, not sliding

The stores implement a **fixed window**: the first request starts a window of
`windowMs`, subsequent requests increment a counter, and the window resets once
it expires.

That is the algorithm the majority of the implementations this was extracted
from used: seven of the nine surveyed kept a `{ count, resetAt }` pair per key.
The other two kept a list of request timestamps and pruned it on every call,
which is a sliding window; both paid for it in memory proportional to the
traffic they were trying to limit.

Both stores use it, so a limiter enforces the same thing whether or not Redis
is configured — which was not true of the code this replaced.

A fixed window admits, worst case, up to `2 × limit` requests across a window
boundary. If that matters more to you than the cost, keep a sliding window
outside this package — the `RateLimitStore` interface is three methods and is
public for exactly that reason.

### Choosing the bucket key

`getClientId(request)` is the default `keyFn`, and it exists because the obvious
implementation is wrong. `x-forwarded-for` is a list that proxies *append* to,
so its left-most entry is whatever the caller invented and its right-most entry
is the hop your own edge added. Reading `[0]` lets anyone mint a fresh
rate-limit bucket per request just by rotating a header.

The order is: platform-set single-value headers first
(`x-vercel-forwarded-for`, `cf-connecting-ip`, `x-real-ip`), then the
**right-most** `x-forwarded-for` entry, then an optional session cookie, then a
UA fingerprint — so that unidentified callers get their own bucket instead of
sharing one global `"anonymous"` bucket a single client could exhaust for
everyone.

```ts
getClientId(request, { sessionCookieNames: ["__session"] });
```

## `@gr8monk3ys/next-kit/stripe`

```ts
import {
  stripe,
  getStripe,
  setDefaultStripeConfig,
  constructWebhookEvent,
  createCheckoutSession,
  createBillingPortalSession,
  isStripeConfigured,
} from "@gr8monk3ys/next-kit/stripe";

// The client is built on first property access, never at import time.
const session = await createCheckoutSession({
  customerId,
  priceId: process.env.STRIPE_PRICE_ID!,
  successUrl: "https://app.example/billing?ok=1",
  cancelUrl: "https://app.example/pricing",
  metadata: { userId },
  trialPeriodDays: 14,
});

// Webhook route: reads the RAW body itself, so the signature still verifies.
export async function POST(request: Request) {
  const event = await constructWebhookEvent(request); // uses STRIPE_WEBHOOK_SECRET
  // ...
}
```

Laziness is the point. `new Stripe(key)` at module scope throws during
`next build` on any machine without the secret, which is every CI runner. The
key is read from `STRIPE_SECRET_KEY`, falling back to `STRIPE_API_KEY`, with
wrapping quotes stripped — pasted `.env` values arrive with them often enough to
be worth handling.

### Pinning an API version

Clients are memoized on the secret key **and** the resolved config. If you pin
an `apiVersion`, set it once at module scope so the bare `stripe` proxy carries
it too:

```ts
setDefaultStripeConfig({ apiVersion: "2026-05-27.dahlia" });
```

Pass `config` to `getStripe()` only when you want a *separate* client with
different settings — each distinct config gets its own instance.

## `@gr8monk3ys/next-kit/auth/clerk`

```ts
import { createClerkAuth, UnauthorizedError } from "@gr8monk3ys/next-kit/auth/clerk";

export const { getUserOrNull, requireUser, requireRole, hasRole } = createClerkAuth({
  resolveUser: (clerkId) =>
    prisma.user.findUnique({
      where: { clerkId },
      select: { id: true, email: true, role: true },
    }),
});

// In a server component or route handler:
const user = await requireUser();          // throws UnauthorizedError (401)
const admin = await requireRole("admin");  // throws ForbiddenError (403)
```

The package deliberately does not talk to your database. Apps look up their own
user row by `clerkId`, against their own schema, returning their own shape — so
that lookup stays in the app as `resolveUser`, and only the Clerk plumbing lives
here. A signed-in Clerk user with no local row is treated as signed out.

`requireRole` reads a `role` string off the resolved user by default; pass
`getRole` for anything else.

**`requireUser` and `requireRole` throw — they do not redirect.** That makes
them right for route handlers and wrong for Server Components:

```ts
// Route handler: catch and map.
export async function GET() {
  try {
    return Response.json(await load(await requireUser()));
  } catch (error) {
    const response = authErrorResponse(error); // 401 / 403, or null
    if (response) return response;
    throw error;
  }
}

// Server Component: do NOT let it throw. An uncaught throw renders the error
// boundary — the visitor gets a 500, not a sign-in prompt.
const user = await getUserOrNull();
if (!user) redirect("/sign-in");
```

For an environment-gated bypass (E2E runs, a local fallback session), pass
`fallback` — it is consulted *before* Clerk and short-circuits it:

```ts
createClerkAuth({
  resolveUser,
  fallback: {
    enabled: () => process.env.E2E_LOCAL_AUTH === "true",
    resolve: () => getE2EUser(),
  },
});
```

`@clerk/nextjs` is loaded dynamically on first use, and nothing here is typed
against a specific Clerk major — v6 and v7 both work. `setClerkModule()` injects
a stand-in for tests.

`authErrorResponse(error)` turns `UnauthorizedError` / `ForbiddenError` into a
401 / 403 JSON response and returns `null` for anything else, so a catch block
can re-throw what it does not recognise.

## Development

```bash
bun install
bun run test        # vitest
bun run typecheck   # tsc --noEmit
bun run build       # tsup -> dist/
```

`dist/` is committed. The tarball is a `git archive` of the tag, so anything not
in the repository is not in the package — and the `require` condition resolves
into `dist/`.

## License

MIT
