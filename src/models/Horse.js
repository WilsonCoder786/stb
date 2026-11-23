const mongoose = require('mongoose');

const horseSchema = new mongoose.Schema(
  {
    barnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Barn',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Horse name is required'],
      trim: true,
      maxlength: [100, 'Horse name cannot exceed 100 characters'],
    },
    stall: {
      type: String,
      required: [true, 'Stall is required'],
      trim: true,
    },
    aisle: {
      type: String,
      default: 'A',
      trim: true,
    },
    type: {
      type: String,
      trim: true,
    },
    age: {
      type: Number,
      min: [0, 'Age must be non-negative'],
    },
    dob: {
      type: Date,
    },
    discipline: {
      type: String,
      trim: true,
    },
    workLevel: {
      type: String,
      trim: true,
    },
    photoUrl: {
      type: String,
      trim: true,
    },
    archived: {
      type: Boolean,
      default: false,
    },
    away: {
      type: Boolean,
      default: false,
    },
    monitoringEnabled: {
      type: Boolean,
      default: false,
    },
    subscription: {
      type: String,
      enum: ['none', 'active', 'expired'],
      default: 'none',
    },
    renewsAt: {
      type: Date,
    },
    cardLast4: {
      type: String,
      trim: true,
      maxlength: 4,
    },
    stripeCustomerId: {
      type: String,
    },
    stripeSubscriptionId: {
      type: String,
    },
    lastCheckoutId: {
      type: String,
    },
    pendingCheckout: {
      checkoutId: { type: String },
      plan: { type: String, enum: ['monthly', 'yearly'] },
      cardLast4: { type: String, maxlength: 4 },
    },
    baselineApproved: {
      type: Boolean,
      default: false,
    },
    stallEffectiveAt: {
      type: Date,
    },
    waterTarget: {
      type: Number,
      default: 12,
    },
    waterTargetRange: {
      type: Number,
      default: 2,
    },
    lowWaterCheckPercent: {
      type: Number,
      default: 20,
    },
    urgentNoDrinkHours: {
      type: Number,
      default: 8,
    },
    highWaterPercent: {
      type: Number,
      default: 35,
    },
    hoursWithoutDrink: {
      type: Number,
      default: 6,
    },
    sensorId: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

horseSchema.index({ 'pendingCheckout.checkoutId': 1 });
horseSchema.index({ stripeSubscriptionId: 1 });

module.exports = mongoose.model('Horse', horseSchema);
