import Stripe from 'stripe';
export { default as Stripe } from 'stripe';

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

/**
 * Set config applied to every client this module builds, including the ones
 * behind the bare `stripe` proxy.
 *
 * This is how an app pins an `apiVersion` once and has it hold everywhere.
 * Without it, `stripe.customers` and `getStripe({ config: { apiVersion } })`
 * would each build their own client and only one of them would carry the pin.
 * Call it at module scope, before anything touches the client.
 */
declare function setDefaultStripeConfig(config?: Stripe.StripeConfig): void;
interface GetStripeOptions {
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
declare function getStripe(options?: GetStripeOptions): Stripe;
/** Drop every memoized client. For tests that swap `process.env`. */
declare function resetStripeClient(): void;
/**
 * A `Stripe` you can import at module scope and destructure freely; the real
 * client is constructed on the first property read.
 *
 * ```ts
 * import { stripe } from "@gr8monk3ys/next-kit/stripe";
 * await stripe.checkout.sessions.create({ ... });
 * ```
 */
declare const stripe: Stripe;
/** True when a secret key and a publishable key are both present. */
declare function isStripeConfigured(): boolean;
interface ConstructWebhookEventOptions {
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
declare function constructWebhookEvent(request: Request, secretOrOptions?: string | ConstructWebhookEventOptions): Promise<Stripe.Event>;
interface CreateCheckoutSessionParams {
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
declare function createCheckoutSession(params: CreateCheckoutSessionParams): Promise<Stripe.Checkout.Session>;
interface CreateBillingPortalSessionParams {
    customerId: string;
    returnUrl: string;
    client?: Pick<Stripe, "billingPortal">;
}
/** Create a Billing Portal session. */
declare function createBillingPortalSession(params: CreateBillingPortalSessionParams): Promise<Stripe.BillingPortal.Session>;

export { type ConstructWebhookEventOptions, type CreateBillingPortalSessionParams, type CreateCheckoutSessionParams, type GetStripeOptions, constructWebhookEvent, createBillingPortalSession, createCheckoutSession, getStripe, isStripeConfigured, resetStripeClient, setDefaultStripeConfig, stripe };
