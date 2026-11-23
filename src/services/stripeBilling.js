const Stripe = require('stripe');
const Horse = require('../models/Horse');
const Subscription = require('../models/Subscription');
const { renewalDate, applyCheckout } = require('./billing');
const { amountFor } = require('../config/planSheet');

let stripeClient;

const getStripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
};

const stripeEnabled = () => Boolean(getStripe());

const LOOKUP_KEYS = {
  barn: { monthly: 'stable_barn_monthly', yearly: 'stable_barn_yearly' },
  horse: { monthly: 'stable_horse_monthly', yearly: 'stable_horse_yearly' },
};

const NAMES = {
  barn: 'Barn staff plan',
  horse: 'Horse subscription',
};

const clientSecretOf = (invoice) => {
  if (!invoice || typeof invoice === 'string') return null;
  if (invoice.confirmation_secret && invoice.confirmation_secret.client_secret) {
    return invoice.confirmation_secret.client_secret;
  }
  const intent = invoice.payment_intent;
  if (intent && typeof intent === 'object' && intent.client_secret) return intent.client_secret;
  return null;
};

const ensureCustomer = async (stripe, { customerId, email, barnId }) => {
  if (customerId) {
    try {
      const existing = await stripe.customers.retrieve(customerId);
      if (!existing.deleted) return existing;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }
  return stripe.customers.create({
    email,
    metadata: { barnId: String(barnId) },
  });
};

const ensurePrice = async (stripe, kind, plan) => {
  const lookupKey = LOOKUP_KEYS[kind][plan];
  const { amount, currency, interval } = amountFor(kind, plan);
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const current = existing.data[0];
  if (current && current.unit_amount === amount && current.currency === currency) return current.id;

  const created = await stripe.prices.create({
    currency,
    unit_amount: amount,
    recurring: { interval },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    product_data: {
      name: NAMES[kind],
      metadata: { kind, plan },
    },
  });
  return created.id;
};

const ephemeralKeyFor = async (stripe, customerId) => {
  const key = await stripe.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: process.env.STRIPE_API_VERSION || '2024-06-20' }
  );
  return key.secret;
};

const createSubscription = async (stripe, fields) => {
  try {
    return await stripe.subscriptions.create({
      ...fields,
      expand: ['latest_invoice.confirmation_secret'],
    });
  } catch (err) {
    if (!/confirmation_secret/i.test(err.message || '')) throw err;
    return stripe.subscriptions.create({
      ...fields,
      expand: ['latest_invoice.payment_intent'],
    });
  }
};

/**
 * Creates a monthly or yearly subscription and the secrets for a mobile payment sheet.
 * Does not open a Stripe Checkout page and does not use a pre-set product price id.
 */
const createPaymentSheet = async ({ kind, barnId, horseId, plan, customerId, customerEmail }) => {
  const stripe = getStripe();
  if (!stripe) {
    const err = new Error('Stripe is not configured');
    err.status = 500;
    throw err;
  }

  const metadata = {
    kind,
    barnId: String(barnId),
    horseId: horseId ? String(horseId) : '',
    plan,
  };
  const customer = await ensureCustomer(stripe, { customerId, email: customerEmail, barnId });
  const price = await ensurePrice(stripe, kind, plan);
  const subscription = await createSubscription(stripe, {
    customer: customer.id,
    items: [{ price, quantity: 1 }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    metadata,
  });
  const paymentIntentClientSecret = clientSecretOf(subscription.latest_invoice);
  if (!paymentIntentClientSecret) {
    const err = new Error('Stripe did not return a payment sheet secret');
    err.status = 502;
    throw err;
  }

  return {
    subscriptionId: subscription.id,
    customerId: customer.id,
    ephemeralKey: await ephemeralKeyFor(stripe, customer.id),
    paymentIntentClientSecret,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || undefined,
  };
};

const changeBarnPrice = async (subscription, plan) => {
  const stripe = getStripe();
  const price = await ensurePrice(stripe, 'barn', plan);
  const current = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
  const item = current.items.data[0];
  const metadata = {
    kind: 'barn',
    barnId: String(subscription.barnId),
    plan,
  };
  let updated;
  try {
    updated = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{ id: item.id, price }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'default_incomplete',
      metadata,
      expand: ['latest_invoice.confirmation_secret'],
    });
  } catch (err) {
    if (!/confirmation_secret/i.test(err.message || '')) throw err;
    updated = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{ id: item.id, price }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'default_incomplete',
      metadata,
      expand: ['latest_invoice.payment_intent'],
    });
  }

  const paymentIntentClientSecret = clientSecretOf(updated.latest_invoice);
  return {
    stripeSubscription: updated,
    paymentSheet: paymentIntentClientSecret
      ? {
          subscriptionId: updated.id,
          customerId: typeof updated.customer === 'string' ? updated.customer : updated.customer.id,
          ephemeralKey: await ephemeralKeyFor(stripe, typeof updated.customer === 'string' ? updated.customer : updated.customer.id),
          paymentIntentClientSecret,
          publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || undefined,
        }
      : null,
  };
};

const constructEvent = (payload, signature) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('Stripe webhook is not configured');
    err.status = 500;
    throw err;
  }
  const stripe = getStripe() || new Stripe('sk_test_construct_only');
  return stripe.webhooks.constructEvent(payload, signature, secret);
};

const syncStripeSubscription = async (stripeSub) => {
  const renewsAt = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000)
    : undefined;
  const plan = stripeSub.metadata && stripeSub.metadata.plan;

  if (stripeSub.metadata && stripeSub.metadata.kind === 'horse') {
    const horse = await Horse.findOne({
      $or: [
        { stripeSubscriptionId: stripeSub.id },
        ...(stripeSub.metadata.horseId ? [{ _id: stripeSub.metadata.horseId }] : []),
      ],
    });
    if (!horse) return;
    horse.subscription = 'active';
    horse.monitoringEnabled = true;
    horse.stripeSubscriptionId = stripeSub.id;
    horse.stripeCustomerId = stripeSub.customer;
    if (renewsAt) horse.renewsAt = renewsAt;
    await horse.save();
    return;
  }

  const barnId = stripeSub.metadata && stripeSub.metadata.barnId;
  const subscription = await Subscription.findOne({
    $or: [
      { stripeSubscriptionId: stripeSub.id },
      ...(barnId ? [{ barnId }] : []),
    ],
  });
  if (!subscription) return;
  if (plan === 'monthly' || plan === 'yearly') subscription.plan = plan;
  subscription.status = 'active';
  subscription.stripeSubscriptionId = stripeSub.id;
  subscription.stripeCustomerId = stripeSub.customer;
  if (renewsAt) subscription.renewsAt = renewsAt;
  await subscription.save();
};

const failStripeSubscription = async (stripeSubscriptionId, metadata = {}) => {
  if (!stripeSubscriptionId && !(metadata && metadata.horseId) && !(metadata && metadata.barnId)) return;

  if (metadata.kind === 'horse' || metadata.horseId) {
    const horse = await Horse.findOne({
      $or: [
        ...(stripeSubscriptionId ? [{ stripeSubscriptionId }] : []),
        ...(metadata.horseId ? [{ _id: metadata.horseId }] : []),
      ],
    });
    if (horse && horse.subscription === 'active') {
      horse.subscription = 'expired';
      horse.monitoringEnabled = false;
      await horse.save();
    }
    return;
  }

  const subscription = await Subscription.findOne({
    $or: [
      ...(stripeSubscriptionId ? [{ stripeSubscriptionId }] : []),
      ...(metadata.barnId ? [{ barnId: metadata.barnId }] : []),
    ],
  });
  if (subscription && subscription.status === 'active') {
    subscription.status = 'missed';
    await subscription.save();
  }
};

const dispatchStripeEvent = async (event) => {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        return;
      }
      let renewsAt;
      const stripe = getStripe();
      if (stripe && session.subscription) {
        const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
        if (stripeSub.current_period_end) renewsAt = new Date(stripeSub.current_period_end * 1000);
      }
      const metadata = session.metadata || {};
      if (!renewsAt && (metadata.plan === 'monthly' || metadata.plan === 'yearly')) {
        renewsAt = renewalDate(metadata.plan);
      }
      await applyCheckout(session.id, 'payment.succeeded', {
        stripeCustomerId: session.customer || undefined,
        stripeSubscriptionId: session.subscription || undefined,
        renewsAt,
      });
      return;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      if (!invoice.subscription) return;
      const periodEnd = invoice.lines && invoice.lines.data && invoice.lines.data[0] && invoice.lines.data[0].period
        ? invoice.lines.data[0].period.end
        : undefined;
      const renewsAt = periodEnd ? new Date(periodEnd * 1000) : undefined;
      const horse = await Horse.findOne({ stripeSubscriptionId: invoice.subscription });
      if (horse) {
        horse.subscription = 'active';
        horse.monitoringEnabled = true;
        horse.pendingCheckout = undefined;
        if (renewsAt) horse.renewsAt = renewsAt;
        await horse.save();
        return;
      }
      const subscription = await Subscription.findOne({ stripeSubscriptionId: invoice.subscription });
      if (!subscription) return;
      if (subscription.pendingCheckout && subscription.pendingCheckout.plan) {
        subscription.plan = subscription.pendingCheckout.plan;
        if (subscription.pendingCheckout.cardLast4) {
          subscription.cardLast4 = subscription.pendingCheckout.cardLast4;
        }
      }
      subscription.status = 'active';
      subscription.pendingCheckout = undefined;
      if (renewsAt) subscription.renewsAt = renewsAt;
      await subscription.save();
      return;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await failStripeSubscription(invoice.subscription, invoice.metadata || {});
      return;
    }
    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object;
      await failStripeSubscription(stripeSub.id, stripeSub.metadata || {});
      return;
    }
    case 'customer.subscription.updated': {
      const stripeSub = event.data.object;
      if (['canceled', 'unpaid', 'incomplete_expired', 'past_due'].includes(stripeSub.status)) {
        await failStripeSubscription(stripeSub.id, stripeSub.metadata || {});
      } else if (stripeSub.status === 'active' || stripeSub.status === 'trialing') {
        await syncStripeSubscription(stripeSub);
      }
      return;
    }
    default:
      return;
  }
};

module.exports = {
  getStripe,
  stripeEnabled,
  createPaymentSheet,
  changeBarnPrice,
  constructEvent,
  dispatchStripeEvent,
};
