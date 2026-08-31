import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";

import {
  getStripe,
  resetStripeClient,
  setDefaultStripeConfig,
  stripe,
} from "../stripe/index";

/**
 * These use the REAL Stripe class rather than a mock, because the thing under
 * test is which config actually reached the constructor. `getApiField("version")`
 * reports the version the client resolved, so the assertion cannot be fooled by
 * a mock that records arguments it was never asked to honour.
 */
const PINNED = "2026-05-27.dahlia";
const OTHER = "2025-03-31.basil";

/**
 * `stripe` types `apiVersion` as the single literal that release ships, so a
 * test that deliberately pins *other* versions has to widen it. A consumer
 * pinning a version its own stripe release knows about needs no cast.
 */
function pin(version: string): Stripe.StripeConfig {
  return { apiVersion: version as Stripe.StripeConfig["apiVersion"] };
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, STRIPE_SECRET_KEY: "sk_test_cache" };
  setDefaultStripeConfig(undefined);
  resetStripeClient();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  setDefaultStripeConfig(undefined);
  resetStripeClient();
});

function versionOf(client: unknown): string {
  return (client as { getApiField(name: string): string }).getApiField("version");
}

describe("client memoization is keyed on config, not just the secret", () => {
  it("keeps the pin when the bare proxy is touched FIRST", () => {
    // The regression: the proxy calls getStripe() with no config, and a
    // key-only cache then hands that unconfigured client to every later caller.
    void stripe.customers;

    const pinned = getStripe({ config: pin(PINNED) });
    expect(versionOf(pinned)).toBe(PINNED);
  });

  it("keeps the pin when the pinned client is built FIRST", () => {
    const pinned = getStripe({ config: pin(PINNED) });
    void stripe.customers;

    expect(versionOf(pinned)).toBe(PINNED);
    expect(getStripe({ config: pin(PINNED) })).toBe(pinned);
  });

  it("gives the same config the same instance, and different configs different ones", () => {
    const a = getStripe({ config: pin(PINNED) });
    const b = getStripe({ config: pin(PINNED) });
    const c = getStripe({ config: pin(OTHER) });

    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(versionOf(c)).toBe(OTHER);
  });

  it("does not collide two distinct object-valued options on one entry", () => {
    const first = getStripe({ config: { httpAgent: { id: 1 } as never } });
    const second = getStripe({ config: { httpAgent: { id: 2 } as never } });
    expect(second).not.toBe(first);
  });

  it("rebuilds when the secret key changes", () => {
    const first = getStripe({ config: pin(PINNED) });
    process.env.STRIPE_SECRET_KEY = "sk_test_rotated";
    const second = getStripe({ config: pin(PINNED) });

    expect(second).not.toBe(first);
    expect(versionOf(second)).toBe(PINNED);
  });
});

describe("setDefaultStripeConfig", () => {
  it("pins the bare proxy too, whatever the access order", () => {
    setDefaultStripeConfig(pin(PINNED));

    // Reach the client through the proxy — no config passed at this call site.
    void stripe.customers;
    expect(versionOf(getStripe())).toBe(PINNED);

    // And the proxy and the explicit getter are the SAME client, so an app that
    // pins once does not end up with two differently-configured clients.
    expect(stripe.customers).toBe(getStripe().customers);
  });

  it("is overridable per call", () => {
    setDefaultStripeConfig(pin(PINNED));
    const override = getStripe({ config: pin(OTHER) });
    expect(versionOf(override)).toBe(OTHER);
    expect(versionOf(getStripe())).toBe(PINNED);
  });
});
