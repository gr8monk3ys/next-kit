/**
 * `@gr8monk3ys/next-kit`
 *
 * Server-side building blocks for Next.js apps: rate limiting, Stripe, and
 * Clerk auth helpers.
 *
 * Import from the subpaths so an app pulls in only what it uses:
 *
 * ```ts
 * import { createRateLimiter } from "@gr8monk3ys/next-kit/rate-limit";
 * import { stripe } from "@gr8monk3ys/next-kit/stripe";
 * import { createClerkAuth } from "@gr8monk3ys/next-kit/auth/clerk";
 * ```
 *
 * This root entry re-exports the two dependency-free modules. `stripe` is
 * subpath-only on purpose: it imports the `stripe` package at module scope, and
 * an app that only wants a rate limiter should not have to install it.
 */

export * from "./rate-limit/index";
export * from "./auth/clerk";
