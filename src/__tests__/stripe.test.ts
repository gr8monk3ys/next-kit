import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";

import {
  getStripe,
  resetStripeClient,
  isStripeConfigured,
  constructWebhookEvent,
  createCheckoutSession,
  createBillingPortalSession,
} from "../stripe/index";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_API_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  resetStripeClient();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetStripeClient();
});

describe("getStripe", () => {
  it("throws a named error when no key is configured", () => {
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY or STRIPE_API_KEY/);
  });

  it("is lazy: importing the module does not construct a client", () => {
    // If construction happened at import time the beforeEach above, which
    // deletes the key, would already have thrown.
    expect(() => getStripe()).toThrow();
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    expect(getStripe()).toBeTruthy();
  });

  it("memoizes one client per key, and rebuilds when the key changes", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    const first = getStripe();
    expect(getStripe()).toBe(first);

    process.env.STRIPE_SECRET_KEY = "sk_test_def";
    const second = getStripe();
    expect(second).not.toBe(first);
    expect(getStripe()).toBe(second);
  });

  it("accepts STRIPE_API_KEY as an alias, and strips wrapping quotes", () => {
    process.env.STRIPE_API_KEY = '"sk_test_quoted"';
    const quoted = getStripe();

    // The cache key is built from the NORMALIZED secret, so a bare value and a
    // quote-wrapped one resolve to the very same client — which is only true if
    // the quotes were stripped before the key reached Stripe.
    process.env.STRIPE_API_KEY = "sk_test_quoted";
    expect(getStripe()).toBe(quoted);
  });
});

describe("configuration reporting", () => {
  it("isStripeConfigured needs both a secret and a publishable key", () => {
    expect(isStripeConfigured()).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    expect(isStripeConfigured()).toBe(false);
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_abc";
    expect(isStripeConfigured()).toBe(true);
  });

});

describe("constructWebhookEvent", () => {
  const event = { id: "evt_1", type: "checkout.session.completed" } as Stripe.Event;

  function mockClient(impl?: () => Stripe.Event) {
    return {
      webhooks: {
        constructEvent: vi.fn(
          impl ??
            (() => event),
        ),
      },
    } as unknown as Pick<Stripe, "webhooks">;
  }

  it("passes the RAW body, the signature header, and the secret to Stripe", async () => {
    const client = mockClient();
    const body = '{"id":"evt_1","spacing":  "preserved"}';
    const request = new Request("https://example.test/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      body,
    });

    await expect(
      constructWebhookEvent(request, { secret: "whsec_x", client }),
    ).resolves.toBe(event);

    expect(client.webhooks.constructEvent).toHaveBeenCalledWith(
      body,
      "t=1,v1=deadbeef",
      "whsec_x",
    );
  });

  it("reads the secret from the environment when not given one", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_env";
    const client = mockClient();
    const request = new Request("https://example.test/hook", {
      method: "POST",
      headers: { "stripe-signature": "sig" },
      body: "{}",
    });

    await constructWebhookEvent(request, { client });
    expect(client.webhooks.constructEvent).toHaveBeenCalledWith("{}", "sig", "whsec_env");
  });

  it("rejects when the secret is missing", async () => {
    const request = new Request("https://example.test/hook", {
      method: "POST",
      headers: { "stripe-signature": "sig" },
      body: "{}",
    });
    await expect(constructWebhookEvent(request)).rejects.toThrow(
      "STRIPE_WEBHOOK_SECRET is not configured",
    );
  });

  it("rejects when the signature header is missing", async () => {
    const request = new Request("https://example.test/hook", {
      method: "POST",
      body: "{}",
    });
    await expect(
      constructWebhookEvent(request, { secret: "whsec_x", client: mockClient() }),
    ).rejects.toThrow("Missing stripe-signature header");
  });

  it("propagates a signature verification failure rather than swallowing it", async () => {
    const client = mockClient(() => {
      throw new Error("No signatures found matching the expected signature");
    });
    const request = new Request("https://example.test/hook", {
      method: "POST",
      headers: { "stripe-signature": "bad" },
      body: "{}",
    });

    await expect(
      constructWebhookEvent(request, { secret: "whsec_x", client }),
    ).rejects.toThrow(/No signatures found/);
  });
});

describe("createCheckoutSession", () => {
  function mockClient() {
    return {
      checkout: {
        sessions: { create: vi.fn(async () => ({ id: "cs_1", url: "https://pay" })) },
      },
    } as unknown as Pick<Stripe, "checkout">;
  }

  it("builds a subscription session with metadata on both the session and the sub", async () => {
    const client = mockClient();
    await createCheckoutSession({
      client,
      customerId: "cus_1",
      priceId: "price_1",
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      metadata: { userId: "u1" },
      trialPeriodDays: 14,
    });

    expect(client.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      success_url: "https://app/ok",
      cancel_url: "https://app/no",
      customer: "cus_1",
      metadata: { userId: "u1" },
      subscription_data: { metadata: { userId: "u1" }, trial_period_days: 14 },
    });
  });

  it("uses customer_email when there is no customer id", async () => {
    const client = mockClient();
    await createCheckoutSession({
      client,
      customerEmail: "a@b.test",
      priceId: "price_1",
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
    });

    const args = vi.mocked(client.checkout.sessions.create).mock.calls[0]![0];
    expect(args).toMatchObject({ customer_email: "a@b.test" });
    expect(args).not.toHaveProperty("customer");
  });

  it("omits subscription_data in payment mode", async () => {
    const client = mockClient();
    await createCheckoutSession({
      client,
      mode: "payment",
      customerId: "cus_1",
      priceId: "price_1",
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      metadata: { tipId: "t1" },
      trialPeriodDays: 7,
    });

    const args = vi.mocked(client.checkout.sessions.create).mock.calls[0]![0];
    expect(args).not.toHaveProperty("subscription_data");
    expect(args).toMatchObject({ mode: "payment" });
  });

  it("lets overrides win", async () => {
    const client = mockClient();
    await createCheckoutSession({
      client,
      customerId: "cus_1",
      priceId: "price_1",
      successUrl: "https://app/ok",
      cancelUrl: "https://app/no",
      overrides: { payment_method_types: ["card"], allow_promotion_codes: true },
    });

    expect(vi.mocked(client.checkout.sessions.create).mock.calls[0]![0]).toMatchObject({
      payment_method_types: ["card"],
      allow_promotion_codes: true,
    });
  });
});

describe("createBillingPortalSession", () => {
  it("passes customer and return_url", async () => {
    const client = {
      billingPortal: {
        sessions: { create: vi.fn(async () => ({ id: "bps_1", url: "https://portal" })) },
      },
    } as unknown as Pick<Stripe, "billingPortal">;

    await createBillingPortalSession({
      client,
      customerId: "cus_1",
      returnUrl: "https://app/billing",
    });

    expect(client.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_1",
      return_url: "https://app/billing",
    });
  });
});
