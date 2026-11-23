const express = require('express');
const { authenticate } = require('../middleware/auth');
const Horse = require('../models/Horse');
const Alert = require('../models/Alert');
const { settleHorses, groupHorses } = require('../services/billing');

const router = express.Router();

/**
 * GET /api/v1/dashboard
 * Urgent, check, and on track include active horse subscriptions only.
 * none or expired horses that are not away are needsSubscription.
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const filter = { barnId: req.user.barnId, archived: { $ne: true } };
    if (req.user.role === 'view_only') {
      filter._id = { $in: req.user.allowedHorseIds };
    }

    const horses = await Horse.find(filter).sort({ aisle: 1, stall: 1, name: 1 }).lean();
    await settleHorses(horses);

    const activeIds = horses.filter((horse) => horse.subscription === 'active').map((horse) => horse._id);
    const alerts = await Alert.find({
      barnId: req.user.barnId,
      horseId: { $in: activeIds },
      state: { $ne: 'resolved' },
    }).lean();

    return res.status(200).json({ success: true, ...groupHorses(horses, alerts) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
