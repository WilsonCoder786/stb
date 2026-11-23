const Subscription = require('../models/Subscription');
const Horse = require('../models/Horse');

const COVERS = 'All staff';

const renewalDate = (plan, from = new Date()) => {
  const renewsAt = new Date(from);
  if (plan === 'monthly') renewsAt.setMonth(renewsAt.getMonth() + 1);
  if (plan === 'yearly') renewsAt.setFullYear(renewsAt.getFullYear() + 1);
  return renewsAt;
};

const presentSubscription = (subscription) => {
  if (!subscription) return null;
  const plain = subscription.toObject ? subscription.toObject() : { ...subscription };
  delete plain.__v;
  return { ...plain, covers: COVERS };
};

const due = (renewsAt) => renewsAt && new Date(renewsAt).getTime() <= Date.now();

const settleBarn = async (subscription) => {
  if (!subscription) return null;
  if (subscription.status === 'active' && due(subscription.renewsAt)) {
    subscription.status = 'missed';
    await Subscription.updateOne({ _id: subscription._id }, { status: 'missed' });
  }
  return subscription;
};

const settleBarnByBarnId = async (barnId) =>
  settleBarn(await Subscription.findOne({ barnId }));

const settleHorse = async (horse) => {
  if (!horse) return horse;
  if (horse.subscription === 'active' && due(horse.renewsAt)) {
    horse.subscription = 'expired';
    horse.monitoringEnabled = false;
    await Horse.updateOne(
      { _id: horse._id },
      { subscription: 'expired', monitoringEnabled: false }
    );
  }
  return horse;
};

const settleHorses = async (horses) => {
  await Promise.all(horses.map((horse) => settleHorse(horse)));
  return horses;
};

const horsePaymentMessage = (horse) =>
  horse.subscription === 'expired' ? 'Subscription expired' : 'Sensor not connected';

const denyUnlessActive = async (res, horse) => {
  await settleHorse(horse);
  if (horse.subscription === 'active') return false;
  res.status(402).json({ success: false, message: horsePaymentMessage(horse) });
  return true;
};

const findCheckout = async (checkoutId) => {
  const subscription = await Subscription.findOne({
    $or: [{ 'pendingCheckout.checkoutId': checkoutId }, { lastCheckoutId: checkoutId }],
  });
  if (subscription) return { kind: 'barn', subscription };

  const horse = await Horse.findOne({
    $or: [{ 'pendingCheckout.checkoutId': checkoutId }, { lastCheckoutId: checkoutId }],
  });
  if (horse) return { kind: 'horse', horse };
  return null;
};

const applyBarnCheckout = async (subscription, checkoutId, event, stripeIds = {}) => {
  const stillPending =
    subscription.pendingCheckout && subscription.pendingCheckout.checkoutId === checkoutId;

  if (!stillPending) {
    const alreadyApplied =
      subscription.lastCheckoutId === checkoutId &&
      ((event === 'payment.succeeded' && subscription.status === 'active') ||
        (event === 'payment.failed' && subscription.status === 'missed'));
    if (alreadyApplied) {
      return { status: 200, body: { success: true, subscription: presentSubscription(subscription) } };
    }
    return { status: 409, body: { success: false, message: 'Checkout is no longer pending' } };
  }

  const update =
    event === 'payment.succeeded'
      ? {
          $set: {
            plan: subscription.pendingCheckout.plan,
            status: 'active',
            cardLast4: subscription.pendingCheckout.cardLast4,
            renewsAt: stripeIds.renewsAt || renewalDate(subscription.pendingCheckout.plan),
            lastCheckoutId: checkoutId,
            ...(stripeIds.stripeCustomerId ? { stripeCustomerId: stripeIds.stripeCustomerId } : {}),
            ...(stripeIds.stripeSubscriptionId
              ? { stripeSubscriptionId: stripeIds.stripeSubscriptionId }
              : {}),
          },
          $unset: { pendingCheckout: '' },
        }
      : {
          $set: { status: 'missed', lastCheckoutId: checkoutId },
          $unset: { pendingCheckout: '' },
        };

  const updated = await Subscription.findOneAndUpdate(
    { _id: subscription._id, 'pendingCheckout.checkoutId': checkoutId },
    update,
    { new: true }
  );

  if (!updated) {
    const current = await Subscription.findOne({ lastCheckoutId: checkoutId });
    if (current) {
      return { status: 200, body: { success: true, subscription: presentSubscription(current) } };
    }
    return { status: 404, body: { success: false, message: 'Checkout not found' } };
  }

  return { status: 200, body: { success: true, subscription: presentSubscription(updated) } };
};

const applyHorseCheckout = async (horse, checkoutId, event, stripeIds = {}) => {
  const stillPending = horse.pendingCheckout && horse.pendingCheckout.checkoutId === checkoutId;

  if (!stillPending) {
    const alreadyApplied =
      horse.lastCheckoutId === checkoutId &&
      ((event === 'payment.succeeded' && horse.subscription === 'active') ||
        (event === 'payment.failed' &&
          (horse.subscription === 'none' || horse.subscription === 'expired')));
    if (alreadyApplied) {
      return { status: 200, body: { success: true, horse } };
    }
    return { status: 409, body: { success: false, message: 'Checkout is no longer pending' } };
  }

  const failedWhileActive = event === 'payment.failed' && horse.subscription === 'active';
  const update =
    event === 'payment.succeeded'
      ? {
          $set: {
            subscription: 'active',
            monitoringEnabled: true,
            cardLast4: horse.pendingCheckout.cardLast4,
            renewsAt: stripeIds.renewsAt || renewalDate(horse.pendingCheckout.plan),
            lastCheckoutId: checkoutId,
            ...(stripeIds.stripeCustomerId ? { stripeCustomerId: stripeIds.stripeCustomerId } : {}),
            ...(stripeIds.stripeSubscriptionId
              ? { stripeSubscriptionId: stripeIds.stripeSubscriptionId }
              : {}),
          },
          $unset: { pendingCheckout: '' },
        }
      : {
          $set: {
            lastCheckoutId: checkoutId,
            ...(failedWhileActive ? { subscription: 'expired', monitoringEnabled: false } : {}),
          },
          $unset: { pendingCheckout: '' },
        };

  const updated = await Horse.findOneAndUpdate(
    { _id: horse._id, 'pendingCheckout.checkoutId': checkoutId },
    update,
    { new: true }
  );

  if (!updated) {
    const current = await Horse.findOne({ lastCheckoutId: checkoutId });
    if (current) return { status: 200, body: { success: true, horse: current } };
    return { status: 404, body: { success: false, message: 'Checkout not found' } };
  }

  return { status: 200, body: { success: true, horse: updated } };
};

const applyCheckout = async (checkoutId, event, stripeIds) => {
  const found = await findCheckout(checkoutId);
  if (!found) return { status: 404, body: { success: false, message: 'Checkout not found' } };
  if (found.kind === 'barn') {
    return applyBarnCheckout(found.subscription, checkoutId, event, stripeIds);
  }
  return applyHorseCheckout(found.horse, checkoutId, event, stripeIds);
};

const groupHorses = (horses, alerts) => {
  const urgentIds = new Set();
  const checkIds = new Set();
  alerts.forEach((alert) => {
    if (alert.state === 'resolved') return;
    const id = String(alert.horseId && alert.horseId._id ? alert.horseId._id : alert.horseId);
    if (alert.severity === 'urgent') urgentIds.add(id);
    if (alert.severity === 'check') checkIds.add(id);
  });

  const urgent = [];
  const check = [];
  const onTrack = [];
  const needsSubscription = [];

  horses.forEach((horse) => {
    if (horse.archived) return;
    if (horse.subscription === 'active') {
      const id = String(horse._id);
      if (urgentIds.has(id)) urgent.push(horse);
      else if (checkIds.has(id)) check.push(horse);
      else onTrack.push(horse);
      return;
    }
    if (!horse.away && (horse.subscription === 'none' || horse.subscription === 'expired')) {
      needsSubscription.push(horse);
    }
  });

  return { urgent, check, onTrack, needsSubscription };
};

module.exports = {
  COVERS,
  renewalDate,
  presentSubscription,
  settleBarn,
  settleBarnByBarnId,
  settleHorse,
  settleHorses,
  horsePaymentMessage,
  denyUnlessActive,
  applyCheckout,
  groupHorses,
};
