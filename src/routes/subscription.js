const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const { getPlanSheet, getSubscription, checkout, checkoutHorse } = require('../controllers/subscriptionController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const allAccess = requireRole('all_access');

const cardValidator = body('cardLast4')
  .optional({ values: 'falsy' })
  .isLength({ min: 4, max: 4 })
  .isNumeric()
  .withMessage('cardLast4 must be exactly 4 digits');

const buyValidators = [
  body('plan').isIn(['monthly', 'yearly']).withMessage('Plan must be monthly or yearly'),
  cardValidator,
];

const horseCheckoutValidators = [
  param('horseId').isMongoId().withMessage('Valid horseId is required'),
  body('plan').optional().isIn(['monthly', 'yearly']).withMessage('Plan must be monthly or yearly'),
  cardValidator,
];

router.use(authenticate, allAccess);

router.get('/plans', getPlanSheet);
router.get('/', getSubscription);
router.post('/checkout', buyValidators, checkout);
router.post('/horses/:horseId/checkout', horseCheckoutValidators, checkoutHorse);

module.exports = router;
