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

/**
 * Clients are memoized on the secret key **and** the resolved config, never on
 * the key alone. Keying on the key alone means whoever calls first wins: touch
 * the bare `stripe` proxy (no config) before calling `getStripe({ config })`
 * and the pinned `apiVersion` is silently dropped, because the unconfigured
 * client is already cached under that key.
 */
const clients = new Map<string, Stripe>();

/**
 * Stable identity for a config value. Objects and functions (`httpAgent`, a
 * custom `httpClient`) get a per-reference id rather than being flattened to
 * "[object]", so two different agents do not collide on one cache entry.
 */
let objectIdSeq = 0;
const objectIds = new WeakMap<object, number>();

function stableValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object" || typeof value === "function") {
    let id = objectIds.get(value as object);
    if (id === undefined) {
      id = (objectIdSeq += 1);
      objectIds.set(value as object, id);
    }
    return `@${id}`;
  }
  return String(value);
}

function fingerprint(config: Stripe.StripeConfig): string {
  return Object.entries(config)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${stableValue(value)}`)
    .join("&");
}

let defaultConfig: Stripe.StripeConfig | undefined;

/**
 * Set config applied to every client this module builds, including the ones
 * behind the bare `stripe` proxy.
 *
 * This is how an app pins an `apiVersion` once and has it hold everywhere.
 * Without it, `stripe.customers` and `getStripe({ config: { apiVersion } })`
 * would each build their own client and only one of them would carry the pin.
 * Call it at module scope, before anything touches the client.
 */
export function setDefaultStripeConfig(config?: Stripe.StripeConfig): void {
  defaultConfig = config;
  clients.clear();
}

export interface GetStripeOptions {
  /**
   * Passed to the `Stripe` constructor, merged over any default set with
   * {@link setDefaultStripeConfig}.
   */
  config?: Stripe.StripeConfig;
}

/**
 * The shared client, built on first call and memoized per (key, config).
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

  const config: Stripe.StripeConfig = {
    typescript: true,
    ...defaultConfig,
    ...options.config,
  };

  // The key is part of the cache key, so a swapped secret (tests do this
  // constantly) builds a new client rather than reusing a stale one.
  const cacheKey = `${key}\u0000${fingerprint(config)}`;

  let client = clients.get(cacheKey);
  if (!client) {
    client = new Stripe(key, config);
    clients.set(cacheKey, client);
  }
  return client;
}

/** Drop every memoized client. For tests that swap `process.env`. */
export function resetStripeClient(): void {
  clients.clear();
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
