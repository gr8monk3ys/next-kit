# next-kit

Server-side building blocks for Next.js apps, published as `@gr8monk3ys/next-kit`: rate limiting, a lazy Stripe client with webhook/checkout/portal helpers, and auth guards for Better Auth and Clerk.

## Rate limiting

**Rate limiter**:
A `RateLimiter` built by `createRateLimiter`: counts requests per key against a limit inside a fixed window and says whether each is admitted.
_Avoid_: Throttle, quota

**Window**:
The fixed span (`windowMs`) during which requests are counted; it expires at `resetAt` and a fresh one starts on the next hit. Fixed, not sliding.
_Avoid_: Bucket, interval

**Store**:
The backing counter behind a limiter (`RateLimitStore`): `MemoryStore`, `RedisStore` or `PostgresStore`. It answers one question, "bump this key and report the window".
_Avoid_: Backend, cache

**Hit**:
One request counted against a key; a `StoreHit` is the resulting `count` and `resetAt`.
_Avoid_: Increment, tick

**Key**:
The string a limiter counts against, derived from a request by `keyFn` (default `getClientId`) and namespaced by the limiter's `prefix`.
_Avoid_: Bucket id

**Client ID**:
The caller's identity as `getClientId` resolves it from request headers, trusting a platform header only when the `ClientIdPlatform` is declared.
_Avoid_: IP address, fingerprint

**Fail open**:
A store's `onError: "open"` behaviour: when its backend errors, the request is admitted. `"closed"` rejects it.
_Avoid_: Soft fail

## Stripe

**Lazy client**:
The Stripe client built on first property access (`stripe`, `getStripe`) rather than at module scope, so `next build` works without the secret.
_Avoid_: Singleton

**Webhook event**:
A Stripe `Event` verified from the raw request body, signature header and secret by `constructWebhookEvent`.
_Avoid_: Callback

**Checkout session**:
A subscription Stripe Checkout session created by `createCheckoutSession`, with metadata on both the session and the subscription.
_Avoid_: Payment link

**Billing portal session**:
A Stripe customer-portal session created by `createBillingPortalSession`, returning the customer to `returnUrl`.
_Avoid_: Customer portal

## Auth

**Guards**:
The four provider-neutral helpers (`AuthGuards`: `getUserOrNull`, `requireUser`, `hasRole`, `requireRole`) that every provider binding returns.
_Avoid_: Middleware, helpers

**Provider binding**:
The Better Auth (`createBetterAuthGuards`) or Clerk (`createClerkAuth`) adapter that supplies the session for the guards. Clerk is kept for existing consumers.
_Avoid_: Adapter, plugin

**Unauthorized / Forbidden**:
`UnauthorizedError` (401, nobody signed in) versus `ForbiddenError` (403, signed in without the role). `authErrorResponse` maps both to JSON.
_Avoid_: AuthError

**Role**:
A string a user holds, read by `getRole` (default `defaultGetRole`, a `role` property); a `RoleValue` may be a single string or a list.
_Avoid_: Permission, scope

**Subpath export**:
A separately importable entry (`/rate-limit`, `/stripe`, `/auth/better-auth`, `/auth/clerk`) so an app installs only the optional peer dependencies it uses.
_Avoid_: Plugin, sub-package
