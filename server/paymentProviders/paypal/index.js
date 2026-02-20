import config from 'config';

import errors from '../../lib/errors';

import payment from './payment';
import subscription from './subscription';

/**
 * PayPal paymentProvider
 * Supports payment and subscription types (PayPal Adaptive has been sunset)
 */

export default {
  types: {
    default: payment,
    payment,
    subscription,
  },

  oauth: {
    redirectUrl: () =>
      Promise.reject(
        new errors.BadRequest(
          'PayPal Adaptive Payments has been discontinued. Please use PayPal Payouts instead: https://documentation.opencollective.com/fiscal-hosts/expense-payment/paying-expenses-with-paypal',
        ),
      ),

    callback: (req, res) => {
      return res.redirect(
        `${config.host.website}?error=PayPal+Adaptive+has+been+discontinued&paypalApprovalStatus=error`,
      );
    },

    verify: (req, res, next) => {
      return next(
        new errors.BadRequest('PayPal Adaptive Payments has been discontinued. Please use PayPal Payouts instead.'),
      );
    },
  },
};
