'use strict';

var Stripe = require('stripe');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var Stripe__default = /*#__PURE__*/_interopDefault(Stripe);

// src/stripe/index.ts
var SECRET_KEY_VARS = ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"];
function normalizeSecret(value) {
  if (!value) return void 0;
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed || void 0;
}
function readSecretKey() {
  for (const name of SECRET_KEY_VARS) {
    const value = normalizeSecret(process.env[name]);
    if (value) return value;
  }
  return void 0;
}
var cached;
var cachedKey;
function getStripe(options = {}) {
  const key = readSecretKey();
  if (!key) {
    throw new Error(
      `Stripe is not configured: set one of ${SECRET_KEY_VARS.join(" or ")}.`
    );
  }
  if (!cached || cachedKey !== key) {
    cached = new Stripe__default.default(key, { typescript: true, ...options.config });
    cachedKey = key;
  }
  return cached;
}
function resetStripeClient() {
  cached = void 0;
  cachedKey = void 0;
}
var stripe = new Proxy({}, {
  get(_target, prop, receiver) {
    const client = getStripe();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, prop) {
    return Reflect.has(getStripe(), prop);
  }
});
function isStripeConfigured() {
  return Boolean(readSecretKey() && process.env.STRIPE_PUBLISHABLE_KEY);
}
function getStripeMode() {
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
async function constructWebhookEvent(request, secretOrOptions) {
  const options = typeof secretOrOptions === "string" ? { secret: secretOrOptions } : secretOrOptions ?? {};
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
async function createCheckoutSession(params) {
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
    overrides
  } = params;
  const create = {
    mode,
    line_items: [{ price: priceId, quantity }],
    success_url: successUrl,
    cancel_url: cancelUrl
  };
  if (customerId) create.customer = customerId;
  else if (customerEmail) create.customer_email = customerEmail;
  if (metadata) create.metadata = metadata;
  if (mode === "subscription" && (metadata || trialPeriodDays)) {
    const subscriptionData = {};
    if (metadata) subscriptionData.metadata = metadata;
    if (trialPeriodDays && trialPeriodDays > 0) {
      subscriptionData.trial_period_days = trialPeriodDays;
    }
    create.subscription_data = subscriptionData;
  }
  const stripeClient = client ?? getStripe();
  return stripeClient.checkout.sessions.create({ ...create, ...overrides });
}
async function createBillingPortalSession(params) {
  const client = params.client ?? getStripe();
  return client.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl
  });
}

exports.constructWebhookEvent = constructWebhookEvent;
exports.createBillingPortalSession = createBillingPortalSession;
exports.createCheckoutSession = createCheckoutSession;
exports.getStripe = getStripe;
exports.getStripeMode = getStripeMode;
exports.isStripeConfigured = isStripeConfigured;
exports.resetStripeClient = resetStripeClient;
exports.stripe = stripe;
