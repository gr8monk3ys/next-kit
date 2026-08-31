/**
 * `@gr8monk3ys/next-kit/stripe`
 *
 * A lazily-constructed Stripe client plus the four things every app around it
 * reimplements: webhook verification, checkout sessions, billing-portal
 * sessions, and "is Stripe even configured".
 *
 * Lazy matters. Constructing `new Stripe(key)` at module scope throws during
 * `next build` on any machine without the secret, which is every CI runner —
 * so the client is built on first property access and not before.
 */

import Stripe from "stripe";

/** Env vars checked for the secret key, in order. */
const SECRET_KEY_VARS = ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"] as const;

/**
 * Values pasted into a dashboard or a `.env` sometimes arrive wrapped in the
 * quotes that were around them. Strip those rather than sending them to Stripe.
 */
function normalizeSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed || undefined;
}

function readSecretKey(): string | undefined {
  for (const name of SECRET_KEY_VARS) {
    const value = normalizeSecret(process.env[name]);
    if (value) return value;
  }
  return undefined;
}

let cached: Stripe | undefined;
let cachedKey: string | undefined;

export interface GetStripeOptions {
  /** Passed straight through to the `Stripe` constructor. */
  config?: Stripe.StripeConfig;
}

/**
 * The shared client, built on first call.
 *
 * @throws if neither `STRIPE_SECRET_KEY` nor `STRIPE_API_KEY` is set.
 */
export function getStripe(options: GetStripeOptions = {}): Stripe {
  const key = readSecretKey();
  if (!key) {
    throw new Error(
      `Stripe is not configured: set one of ${SECRET_KEY_VARS.join(" or ")}.`,
    );
  }
  // Rebuild if the key changed under us (tests swap process.env constantly).
  if (!cached || cachedKey !== key) {
    cached = new Stripe(key, { typescript: true, ...options.config });
    cachedKey = key;
  }
  return cached;
}

/** Drop the memoized client. For tests that swap `process.env`. */
export function resetStripeClient(): void {
  cached = undefined;
  cachedKey = undefined;
}

/**
 * A `Stripe` you can import at module scope and destructure freely; the real
 * client is constructed on the first property read.
 *
 * ```ts
 * import { stripe } from "@gr8monk3ys/next-kit/stripe";
 * await stripe.checkout.sessions.create({ ... });
 * ```
 */
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    const client = getStripe();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, prop) {
    return Reflect.has(getStripe(), prop);
  },
});

/** True when a secret key and a publishable key are both present. */
export function isStripeConfigured(): boolean {
  return Boolean(readSecretKey() && process.env.STRIPE_PUBLISHABLE_KEY);
}

export type StripeMode = "test" | "live" | "unknown";

/**
 * Which Stripe environment the configured keys point at.
 *
 * Safe to surface in admin tooling: it reads the key's prefix, never the key.
 */
export function getStripeMode(): StripeMode {
  const secret = readSecretKey() ?? "";
  const publishable = process.env.STRIPE_PUBLISHABLE_KEY ?? "";
  if (secret.startsWith("sk_test_") || publishable.startsWith("pk_test_")) {
    return "test";
  }
  if (secret.startsWith("sk_live_") || publishable.startsWith("pk_live_")) {
    return "live";
  }
  return "unknown";
}

export interface ConstructWebhookEventOptions {
  /** Signing secret. Default: `process.env.STRIPE_WEBHOOK_SECRET`. */
  secret?: string;
  /** Client to verify with. Default: the shared lazy client. */
  client?: Pick<Stripe, "webhooks">;
  /** Signature header name. Default `"stripe-signature"`. */
  headerName?: string;
}

/**
 * Verify a webhook straight off the `Request`.
 *
 * Reads the raw body with `req.text()` — reading it as JSON first would change
 * the bytes and the signature would never verify.
 *
 * @throws `Stripe.errors.StripeSignatureVerificationError` on a bad signature,
 *   and a plain `Error` when the header or the secret is missing.
 */
export async function constructWebhookEvent(
  request: Request,
  secretOrOptions?: string | ConstructWebhookEventOptions,
): Promise<Stripe.Event> {
  const options: ConstructWebhookEventOptions =
    typeof secretOrOptions === "string"
      ? { secret: secretOrOptions }
      : (secretOrOptions ?? {});

  const secret = options.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }

  const headerName = options.headerName ?? "stripe-signature";
  const signature = request.headers.get(headerName);
  if (!signature) {
    throw new Error(`Missing ${headerName} header`);
  }

  const body = await request.text();
  const client = options.client ?? getStripe();
  return client.webhooks.constructEvent(body, signature, secret);
}

export interface CreateCheckoutSessionParams {
  /** Existing Stripe customer. Omit and pass `customerEmail` for a new one. */
  customerId?: string;
  customerEmail?: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** `"subscription"` (default) or `"payment"`. */
  mode?: Stripe.Checkout.SessionCreateParams.Mode;
  quantity?: number;
  /** Free-trial length. Ignored outside subscription mode. */
  trialPeriodDays?: number;
  /** Copied onto the session and, in subscription mode, the subscription. */
  metadata?: Record<string, string>;
  client?: Pick<Stripe, "checkout">;
  /** Merged last, so it can override anything above. */
  overrides?: Partial<Stripe.Checkout.SessionCreateParams>;
}

/** Create a Checkout session. */
export async function createCheckoutSession(
  params: CreateCheckoutSessionParams,
): Promise<Stripe.Checkout.Session> {
  const {
    customerId,
    customerEmail,
    priceId,
    successUrl,
    cancelUrl,
    mode = "subscription",
    quantity = 1,
    trialPeriodDays,
    metadata,
    client,
    overrides,
  } = params;

  const create: Stripe.Checkout.SessionCreateParams = {
    mode,
    line_items: [{ price: priceId, quantity }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  if (customerId) create.customer = customerId;
  else if (customerEmail) create.customer_email = customerEmail;

  if (metadata) create.metadata = metadata;

  if (mode === "subscription" && (metadata || trialPeriodDays)) {
    const subscriptionData: Stripe.Checkout.SessionCreateParams["subscription_data"] =
      {};
    if (metadata) subscriptionData.metadata = metadata;
    if (trialPeriodDays && trialPeriodDays > 0) {
      subscriptionData.trial_period_days = trialPeriodDays;
    }
    create.subscription_data = subscriptionData;
  }

  const stripeClient = client ?? getStripe();
  return stripeClient.checkout.sessions.create({ ...create, ...overrides });
}

export interface CreateBillingPortalSessionParams {
  customerId: string;
  returnUrl: string;
  client?: Pick<Stripe, "billingPortal">;
}

/** Create a Billing Portal session. */
export async function createBillingPortalSession(
  params: CreateBillingPortalSessionParams,
): Promise<Stripe.BillingPortal.Session> {
  const client = params.client ?? getStripe();
  return client.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl,
  });
}

export type { Stripe };
