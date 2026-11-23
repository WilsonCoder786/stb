const readPrice = (envName) => {
  const raw = process.env[envName];
  if (raw === undefined || String(raw).trim() === '') return null;
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  const amount = Math.round(price * 100);
  if (amount < 1) return null;
  return { price, amount };
};

const intervalPrice = (plan) => {
  const read = readPrice(plan === 'yearly' ? 'YEARLY_PRICE' : 'MONTHLY_PRICE');
  return {
    interval: plan === 'yearly' ? 'year' : 'month',
    price: read ? read.price : null,
    amount: read ? read.amount : null,
  };
};

/**
 * One monthly price and one yearly price.
 * The barn plan and each horse use the price for that interval.
 */
const planSheet = () => {
  const monthly = intervalPrice('monthly');
  const yearly = intervalPrice('yearly');
  return {
    currency: process.env.STRIPE_CURRENCY || 'usd',
    monthly,
    yearly,
    barn: {
      covers: 'All staff',
      monthly,
      yearly,
    },
    horse: {
      covers: 'One horse',
      monthly,
      yearly,
    },
  };
};

const amountFor = (kind, plan) => {
  const charge = intervalPrice(plan);
  if (!charge.amount) {
    const err = new Error(`Set ${plan === 'yearly' ? 'YEARLY_PRICE' : 'MONTHLY_PRICE'}`);
    err.status = 500;
    throw err;
  }
  return {
    amount: charge.amount,
    currency: process.env.STRIPE_CURRENCY || 'usd',
    interval: charge.interval,
    kind,
  };
};

module.exports = { planSheet, amountFor };
