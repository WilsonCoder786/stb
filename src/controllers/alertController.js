const { validationResult } = require('express-validator');
const Alert = require('../models/Alert');
const Horse = require('../models/Horse');
const { settleHorses, denyUnlessActive } = require('../services/billing');

const sendValidationError = (res, errors) =>
  res.status(422).json({ success: false, errors: errors.array() });

/**
 * Helper: can user access a horse with the given horseId?
 */
const canAccessHorseById = (user, horseId) => {
  if (user.role === 'view_only') {
    return user.allowedHorseIds.map(String).includes(String(horseId));
  }
  return true;
};

const ALERT_STATES = ['open', 'acknowledged', 'resolved'];
const ALERT_SEVERITIES = ['check', 'urgent'];

/**
 * POST /api/v1/alerts
 * Manual alert. Sensors do not create alerts in this phase.
 */
const createAlert = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidationError(res, errors);

  try {
    const horse = await Horse.findOne({ _id: req.body.horseId, barnId: req.user.barnId });
    if (!horse) {
      return res.status(404).json({ success: false, message: 'Horse not found' });
    }
    if (!canAccessHorseById(req.user, horse._id)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    if (await denyUnlessActive(res, horse)) return;

    const alert = await Alert.create({
      barnId: req.user.barnId,
      horseId: horse._id,
      severity: req.body.severity,
      kind: req.body.kind,
      message: req.body.message.trim(),
      state: 'open',
    });

    return res.status(201).json({ success: true, alert });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/alerts
 * Returns alerts for the barn; view_only users filtered to allowedHorseIds.
 */
const listAlerts = async (req, res, next) => {
  try {
    const horses = await Horse.find({ barnId: req.user.barnId }).select('_id subscription renewsAt monitoringEnabled').lean();
    await settleHorses(horses);
    const activeIds = horses
      .filter((horse) => horse.subscription === 'active')
      .map((horse) => horse._id);

    const filter = { barnId: req.user.barnId, horseId: { $in: activeIds } };

    if (req.user.role === 'view_only') {
      const allowed = new Set(req.user.allowedHorseIds.map(String));
      filter.horseId = {
        $in: activeIds.filter((id) => allowed.has(String(id))),
      };
    }

    if (req.query.state) {
      if (!ALERT_STATES.includes(req.query.state)) {
        return res.status(422).json({ success: false, message: 'Invalid alert state' });
      }
      filter.state = req.query.state;
    }
    if (req.query.severity) {
      if (!ALERT_SEVERITIES.includes(req.query.severity)) {
        return res.status(422).json({ success: false, message: 'Invalid alert severity' });
      }
      filter.severity = req.query.severity;
    }
    if (req.query.horseId) {
      const hid = req.query.horseId;
      if (req.user.role === 'view_only' && !canAccessHorseById(req.user, hid)) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
      const horse = await Horse.findOne({ _id: hid, barnId: req.user.barnId });
      if (!horse) {
        return res.status(404).json({ success: false, message: 'Horse not found' });
      }
      if (await denyUnlessActive(res, horse)) return;
      filter.horseId = hid;
    }

    const alerts = await Alert.find(filter)
      .sort({ createdAt: -1 })
      .populate('horseId', 'name stall aisle')
      .lean();

    return res.status(200).json({ success: true, alerts });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/alerts/:alertId
 */
const getAlert = async (req, res, next) => {
  try {
    const alert = await Alert.findOne({
      _id: req.params.id,
      barnId: req.user.barnId,
    })
      .populate('horseId', 'name stall aisle')
      .lean();

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    if (!canAccessHorseById(req.user, alert.horseId._id || alert.horseId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const horse = await Horse.findOne({
      _id: alert.horseId._id || alert.horseId,
      barnId: req.user.barnId,
    });
    if (!horse || (await denyUnlessActive(res, horse))) {
      if (!horse) return res.status(404).json({ success: false, message: 'Horse not found' });
      return;
    }

    return res.status(200).json({ success: true, alert });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/alerts/:alertId/acknowledge
 * all_access, basic_access
 */
const acknowledgeAlert = async (req, res, next) => {
  try {
    const alert = await Alert.findOne({
      _id: req.params.id,
      barnId: req.user.barnId,
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    if (!canAccessHorseById(req.user, alert.horseId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const horse = await Horse.findOne({ _id: alert.horseId, barnId: req.user.barnId });
    if (!horse || (await denyUnlessActive(res, horse))) {
      if (!horse) return res.status(404).json({ success: false, message: 'Horse not found' });
      return;
    }

    if (alert.state !== 'open') {
      return res.status(400).json({
        success: false,
        message: `Alert is already ${alert.state}`,
      });
    }

    alert.state = 'acknowledged';
    alert.acknowledgedBy = req.user.name;
    alert.acknowledgedAt = new Date();
    await alert.save();

    return res.status(200).json({ success: true, alert });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/alerts/:alertId/resolve
 * all_access, basic_access – body: { action, note }
 */
const resolveAlert = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendValidationError(res, errors);

  try {
    const alert = await Alert.findOne({
      _id: req.params.id,
      barnId: req.user.barnId,
    });

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    if (!canAccessHorseById(req.user, alert.horseId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const horse = await Horse.findOne({ _id: alert.horseId, barnId: req.user.barnId });
    if (!horse || (await denyUnlessActive(res, horse))) {
      if (!horse) return res.status(404).json({ success: false, message: 'Horse not found' });
      return;
    }

    if (alert.state === 'resolved') {
      return res.status(400).json({ success: false, message: 'Alert is already resolved' });
    }

    const { action, note } = req.body;

    alert.state = 'resolved';
    alert.resolvedBy = req.user.name;
    alert.resolvedAt = new Date();
    if (action) alert.resolutionAction = action;
    if (note) alert.resolutionNote = note;

    // If it was open (skipping acknowledge), set acknowledged too
    if (!alert.acknowledgedAt) {
      alert.acknowledgedBy = req.user.name;
      alert.acknowledgedAt = new Date();
    }

    await alert.save();

    return res.status(200).json({ success: true, alert });
  } catch (err) {
    next(err);
  }
};

module.exports = { createAlert, listAlerts, getAlert, acknowledgeAlert, resolveAlert };
