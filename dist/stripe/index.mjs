import Stripe from 'stripe';

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
var clients = /* @__PURE__ */ new Map();
var objectIdSeq = 0;
var objectIds = /* @__PURE__ */ new WeakMap();
function stableValue(value) {
  if (value === null) return "null";
  if (typeof value === "object" || typeof value === "function") {
    let id = objectIds.get(value);
    if (id === void 0) {
      id = objectIdSeq += 1;
      objectIds.set(value, id);
    }
    return `@${id}`;
  }
  return String(value);
}
function fingerprint(config) {
  return Object.entries(config).filter(([, value]) => value !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${name}=${stableValue(value)}`).join("&");
}
var defaultConfig;
function setDefaultStripeConfig(config) {
  defaultConfig = config;
  clients.clear();
}
function getStripe(options = {}) {
  const key = readSecretKey();
  if (!key) {
    throw new Error(
      `Stripe is not configured: set one of ${SECRET_KEY_VARS.join(" or ")}.`
    );
  }
  const config = {
    typescript: true,
    ...defaultConfig,
    ...options.config
  };
  const cacheKey = `${key}\0${fingerprint(config)}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = new Stripe(key, config);
    clients.set(cacheKey, client);
  }
  return client;
}
function resetStripeClient() {
  clients.clear();
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

export { constructWebhookEvent, createBillingPortalSession, createCheckoutSession, getStripe, isStripeConfigured, resetStripeClient, setDefaultStripeConfig, stripe };
