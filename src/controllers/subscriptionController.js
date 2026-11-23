const crypto = require('crypto');
const { validationResult } = require('express-validator');
const Subscription = require('../models/Subscription');
const Horse = require('../models/Horse');
const User = require('../models/User');
const {
  presentSubscription,
  settleBarn,
  applyCheckout,
} = require('../services/billing');
const { planSheet } = require('../config/planSheet');
const {
  stripeEnabled,
  createPaymentSheet,
  changeBarnPrice,
  constructEvent,
  dispatchStripeEvent,
} = require('../services/stripeBilling');

const sendValidationError = (res, errors) =>
  res.status(422).json({ success: false, errors: errors.array() });

const requireCard = (cardLast4) => /^\d{4}$/.test(String(cardLast4 || ''));

const presentSheet = (sheet, plan, extra = {}) => ({
  checkoutId: sheet.subscriptionId,
  plan,
  status: 'pending',
  provider: 'stripe',
  ...extra,
  paymentSheet: {
    customerId: sheet.customerId,
    ephemeralKey: sheet.ephemeralKey,
    paymentIntentClientSecret: sheet.paymentIntentClientSecret,
    ...(sheet.publishableKey ? { publishableKey: sheet.publishableKey } : {}),
  },
});

/**
 * GET /api/v1/subscription/plans
 * Monthly and yearly amounts for the payment sheet.
 */
const getPlanSheet = async (req, res, next) => {
  try {
    return res.status(200).json({ success: true, ...planSheet() });
  } catch (err) {
    next(err);
  }
};
const getSubscription = async (req, res, next) => {
  try {
    const subscription = await settleBarn(
      await Subscription.findOne({ barnId: req.user.barnId })
    );
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'Subscription not found' });
    }
    return res.status(200).json({ success: true, subscription: presentSubscription(subscription) });
  } catch (err) {
    next(err);
  }
};

const savePending = async (barnId, pendingCheckout) =>
  Subscription.findOneAndUpdate(
    { barnId },
    {
      $set: { pendingCheckout },
      $setOnInsert: { status: 'none' },
    },
    { new: true, upsert: true }
  );

/**
 * POST /api/v1/subscription/checkout
 * Buys or changes the barn staff plan. Does not subscribe horses.
 * Body: { plan, cardLast4? }
 */
const checkout = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidationError(res, errors);

  try {
    const { plan } = req.body;
    const current = await settleBarn(await Subscription.findOne({ barnId: req.user.barnId }));

    if (stripeEnabled()) {
      if (current && current.stripeSubscriptionId && current.status === 'active') {
        const changed = await changeBarnPrice(current, plan);
        current.pendingCheckout = {
          checkoutId: changed.stripeSubscription.id,
          plan,
          cardLast4: requireCard(req.body.cardLast4) ? String(req.body.cardLast4) : current.cardLast4,
        };
        current.stripeSubscriptionId = changed.stripeSubscription.id;
        current.stripeCustomerId = changed.paymentSheet
          ? changed.paymentSheet.customerId
          : current.stripeCustomerId;
        if (!changed.paymentSheet && (changed.stripeSubscription.status === 'active' || changed.stripeSubscription.status === 'trialing')) {
          current.plan = plan;
          current.status = 'active';
          current.pendingCheckout = undefined;
          if (changed.stripeSubscription.current_period_end) {
            current.renewsAt = new Date(changed.stripeSubscription.current_period_end * 1000);
          }
          await current.save();
          return res.status(200).json({
            success: true,
            checkout: { plan, status: 'active', provider: 'stripe' },
            subscription: presentSubscription(current),
          });
        }
        if (!changed.paymentSheet) {
          const err = new Error('Stripe did not return a payment sheet secret');
          err.status = 502;
          throw err;
        }
        await current.save();
        return res.status(200).json({
          success: true,
          checkout: presentSheet(changed.paymentSheet, plan),
          subscription: presentSubscription(current),
        });
      }

      const owner = await User.findById(req.user._id).lean();
      const sheet = await createPaymentSheet({
        kind: 'barn',
        barnId: req.user.barnId,
        plan,
        customerId: current && current.stripeCustomerId,
        customerEmail: owner.email,
      });
      const subscription = await Subscription.findOneAndUpdate(
        { barnId: req.user.barnId },
        {
          $set: {
            pendingCheckout: {
              checkoutId: sheet.subscriptionId,
              plan,
              cardLast4: requireCard(req.body.cardLast4) ? String(req.body.cardLast4) : undefined,
            },
            stripeCustomerId: sheet.customerId,
            stripeSubscriptionId: sheet.subscriptionId,
          },
          $setOnInsert: { status: 'none' },
        },
        { new: true, upsert: true }
      );
      return res.status(200).json({
        success: true,
        checkout: presentSheet(sheet, plan),
        subscription: presentSubscription(subscription),
      });
    }

    if (!requireCard(req.body.cardLast4)) {
      return res.status(422).json({ success: false, message: 'cardLast4 must be exactly 4 digits' });
    }

    const checkoutId = crypto.randomUUID();
    const subscription = await savePending(req.user.barnId, {
      checkoutId,
      plan,
      cardLast4: String(req.body.cardLast4),
    });

    return res.status(200).json({
      success: true,
      checkout: { checkoutId, plan, status: 'pending', provider: 'test' },
      subscription: presentSubscription(subscription),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/subscription/horses/:horseId/checkout
 * Subscribes or renews one horse on the barn's plan.
 * Body: { cardLast4?, plan? }
 */
const checkoutHorse = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidationError(res, errors);

  try {
    const subscription = await settleBarn(
      await Subscription.findOne({ barnId: req.user.barnId })
    );
    if (!subscription || subscription.status !== 'active' || !subscription.plan) {
      return res.status(402).json({ success: false, message: 'Buy the barn subscription' });
    }

    if (req.body.plan && req.body.plan !== subscription.plan) {
      return res.status(422).json({
        success: false,
        message: 'Horse subscription uses the barn plan',
      });
    }

    const horse = await Horse.findOne({ _id: req.params.horseId, barnId: req.user.barnId });
    if (!horse) {
      return res.status(404).json({ success: false, message: 'Horse not found' });
    }

    const plan = subscription.plan;

    if (stripeEnabled()) {
      const owner = await User.findById(req.user._id).lean();
      const sheet = await createPaymentSheet({
        kind: 'horse',
        barnId: req.user.barnId,
        horseId: horse._id,
        plan,
        customerId: horse.stripeCustomerId || subscription.stripeCustomerId,
        customerEmail: owner.email,
      });
      horse.pendingCheckout = {
        checkoutId: sheet.subscriptionId,
        plan,
        cardLast4: requireCard(req.body.cardLast4) ? String(req.body.cardLast4) : undefined,
      };
      horse.stripeCustomerId = sheet.customerId;
      horse.stripeSubscriptionId = sheet.subscriptionId;
      await horse.save();
      return res.status(200).json({
        success: true,
        checkout: presentSheet(sheet, plan, { horseId: horse._id }),
        horse,
      });
    }

    if (!requireCard(req.body.cardLast4)) {
      return res.status(422).json({ success: false, message: 'cardLast4 must be exactly 4 digits' });
    }

    const checkoutId = crypto.randomUUID();
    horse.pendingCheckout = {
      checkoutId,
      plan,
      cardLast4: String(req.body.cardLast4),
    };
    await horse.save();

    return res.status(200).json({
      success: true,
      checkout: { checkoutId, plan, horseId: horse._id, status: 'pending', provider: 'test' },
      horse,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/webhooks/payment
 * Test provider confirmation. Body: { checkoutId, event }
 */
const confirmPayment = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidationError(res, errors);

  try {
    const { checkoutId, event } = req.body;
    const result = await applyCheckout(checkoutId, event);
    return res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/webhooks/stripe
 * Raw body. Stripe signature required.
 */
const stripeWebhook = async (req, res, next) => {
  try {
    const event = constructEvent(req.body, req.get('stripe-signature'));
    await dispatchStripeEvent(event);
    return res.status(200).json({ received: true });
  } catch (err) {
    if (err.type === 'StripeSignatureVerificationError' || /signature/i.test(err.message || '')) {
      return res.status(400).json({ success: false, message: 'Invalid Stripe signature' });
    }
    if (err.status === 500 && /not configured/i.test(err.message || '')) {
      return res.status(500).json({ success: false, message: err.message });
    }
    next(err);
  }
};

module.exports = { getPlanSheet, getSubscription, checkout, checkoutHorse, confirmPayment, stripeWebhook };
