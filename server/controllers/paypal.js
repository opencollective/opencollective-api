import async from 'async';
import config from 'config';
import moment from 'moment';
import models from '../models';
import errors from '../lib/errors';
import paypalAdaptive from '../gateways/paypalAdaptive';

const {
  Activity,
  PaymentMethod
} = models;

/**
 * Get preapproval details route
 */
export const getDetails = function(req, res, next) {
  const preapprovalKey = req.params.preapprovalkey;

  return paypalAdaptive.preapprovalDetails(preapprovalKey)
    .then(paypalResponse => res.json(paypalResponse))
    .catch(next);
};

/**
 * Get a preapproval key for a user.
 */
export const getPreapprovalKey = function(req, res, next) {
  // TODO: The cancel URL doesn't work - no routes right now.
  const uri = `/users/${req.remoteUser.id}/paypal/preapproval/`;
  const baseUrl = config.host.website + uri;
  const cancelUrl = req.query.cancelUrl || (`${baseUrl}/cancel`);
  const returnUrl = req.query.returnUrl || (`${baseUrl}/success`);
  const endingDate = (req.query.endingDate && (new Date(req.query.endingDate)).toISOString()) || moment().add(1, 'years').toISOString();
  
  const maxTotalAmountOfAllPayments = req.query.maxTotalAmountOfAllPayments || 2000; // 2000 is the maximum: https://developer.paypal.com/docs/classic/api/adaptive-payments/Preapproval_API_Operation/

  const payload = {
    currencyCode: 'USD', // TODO: figure out if there is a reliable way to specify correct currency for a HOST.
    startingDate: new Date().toISOString(),
    endingDate,
    returnUrl,
    cancelUrl,
    displayMaxTotalAmount: true,
    feesPayer: 'SENDER',
    maxTotalAmountOfAllPayments,
    clientDetails: req.remoteUser.id
  };

  let response;

  return paypalAdaptive.preapproval(payload)
  .tap(r => response = r)
  .then(response => PaymentMethod.create({
    service: 'paypal',
    UserId: req.remoteUser.id,
    token: response.preapprovalKey
  }))
  .then(() => res.json(response))
  .catch(next);
};

/**
 * Confirm a preapproval.
 */
export const confirmPreapproval = function(req, res, next) {
  let paymentMethod;

  // fetch original payment method
  return PaymentMethod.findOne({
    where: {
      service: 'paypal',
      UserId: req.remoteUser.id,
      token: req.params.preapprovalkey
    }
  })
  .tap(pm => paymentMethod = pm)
  .then(pm => pm ? Promise.resolve() : Promise.reject(new errors.NotFound('This preapprovalKey does not exist.')))

  // get preapprovalkey details from Paypal
  .then(() => paypalAdaptive.preapprovalDetails(req.params.preapprovalkey))
  .tap(response => response.approved === 'false' ? Promise.reject(new errors.BadRequest('This preapprovalkey is not approved yet.')) : Promise.resolve())

  // update paymentMethod
  .then(response => {
    const maxTotalAmountOfAllPayments = response.maxTotalAmountOfAllPayments * 100;
    const amountUsed = response.curPaymentsAmount * 100;
    const amountRemaining = maxTotalAmountOfAllPayments - response.curPaymentsAmount;

    return paymentMethod.update({
      confirmedAt: new Date(),
      number: response.senderEmail,
      data: {
        response,
        maxTotalAmountOfAllPayments,
        amountUsed,
        amountRemaining
      }
    })
  })  
  .then(() => Activity.create({
    type: 'user.paymentMethod.created',
    UserId: req.remoteUser.id,
    data: {
      user: req.remoteUser.info,
      paymentMethod
    }
  }))
  
  // clean any old payment methods
  .then(() => PaymentMethod.findAll({
    where: {
      service: 'paypal',
      UserId: req.remoteUser.id,
      token: {$ne: req.params.preapprovalkey}
    }
  }))
  .then(oldPMs => oldPMs && oldPMs.map(pm => pm.destroy()))

  .then(() => res.send(paymentMethod.info))
  .catch(next)
};
