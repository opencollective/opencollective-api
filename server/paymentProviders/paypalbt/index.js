import braintree from 'braintree';
import config from 'config';

import * as constants from '../../constants/transactions';
import * as roles from '../../constants/roles';
import * as libpayments from '../../lib/payments';
import models from '../../models';
import errors from '../../lib/errors';

export const gateway = braintree.connect({
  environment: braintree.Environment.Sandbox,
  merchantId: config.paypalbt.merchantId,
  publicKey: config.paypalbt.pubKey,
  privateKey: config.paypalbt.privKey,
});

/** Generate a token to be used by the UI
 *
 * The frontend libraries from PayPal and Braintree require a token
 * generated on the server side using the platform's API keys.
 *
 * This function is called via the HTTP API for connected accounts and
 * it's optional in the "Open Collective's Payment Provider" API for
 * payment providers that don't require the token in the UI side.
 */
async function clientToken(req, res, next) {
  const { CollectiveId } = req.query;
  const collective = await models.Collective.findById(CollectiveId);
  if (!collective) return next(new errors.BadRequest('Collective does not exist'));
  try {
    const result = await gateway.clientToken.generate({});
    return res.send({ clientToken: result.clientToken });
  } catch (error) {
    return next(error);
  }
}

/** Retrieve or create a new token for a PayPal user.
 *
 * @param {models.Order} order is the order object created with the
 *  order request from the user.
 */
export async function getOrCreateUserToken(order) {
  if (!order.paymentMethod.customerId) {
    const result = await gateway.customer.create({
      firstName: order.fromCollective.name,
      paymentMethodNonce: order.paymentMethod.token,
    });
    order.paymentMethod.update({
      customerId: result.customer.id,
      token: result.customer.paymentMethods[0].token,
    });
  }
  return order.paymentMethod.token;
}

/** Wrapper for PayPal's `gateway.transaction.sale()` call
 *
 * This helper figures out a PayPal token for the user placing the
 * order, convert the amount value to PayPal's format and execute the
 * sale.
 *
 * @param {models.Order} order is the order object created with the
 *  order request from the user.
 *
 * @see getOrCreateUserToken
 */
async function createPayPalTransaction(order) {
  const paymentMethodToken = await getOrCreateUserToken(order);
  // PayPal uses doubles to store currency values
  const amount = Math.round(order.totalAmount / 100);
  return gateway.transaction.sale({
    paymentMethodToken,
    amount,
    options: {
      submitForSettlement: true
    }
  });
}

/** Convert amount from PayPal to Open Collective format
 *
 * @param {String} amount is the amount in dollars
 * @return {Number} an integer representing the value in cents
 * @example
 * formatAmountValue('1.75')   // 175
 * formatAmountValue('2.55')   // 255
 */
function formatAmountValue(amount) {
  return parseFloat(amount) * 100;
}

/** Create transactions from PayPal charge information.
 *
 * The payment processor fee is retrieved from the PayPal response
 * object.
 *
 * @param {models.Order} order is the order object created with the
 *  order request from the user.
 * @param {Object} paypalTransaction is the result from a sale
 *  operation using the PayPal API.
 */
async function createTransactions(order, paypalTransaction) {
  const { transaction, success } = paypalTransaction;

  if (!success) throw new Error("Unsuccessful PayPal transaction");

  const { paypal: { transactionFeeAmount } } = transaction;

  const payload = {
    CreatedByUserId: order.createdByUser.id,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.collective.id,
    PaymentMethodId: order.paymentMethod.id
  };

  const amount = formatAmountValue(transaction.amount);

  const hostFeeInHostCurrency = libpayments.calcFee(
    amount, order.collective.hostFeePercent);

  const paymentProcessorFeeInHostCurrency =
        formatAmountValue(transactionFeeAmount);

  const platformFeeInHostCurrency = libpayments.calcFee(
    amount, constants.OC_FEE_PERCENT);

  payload.transaction = {
    type: constants.type.CREDIT,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency: paypalTransaction.currencyIsoCode,
    amountInHostCurrency: amount,
    hostCurrencyFxRate: order.totalAmount / amount,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency,
    description: order.description,
    data: { paypalTransaction },
  };

  return models.Transaction.createFromPayload(payload);
}

/** Add user as a backer to the collective
 *
 * @param {models.Order} order is the order object created with the
 *  order request from the user.
 */
async function addUserToCollective(order) {
  return order.collective.findOrAddUserWithRole(
    {
      id: order.createdByUser.id,
      CollectiveId: order.fromCollective.id
    },
    roles.BACKER,
    {
      CreatedByUserId: order.createdByUser.id,
      TierId: order.TierId
    }
  );
}

/** Execute PayPal charge and create transactions in the database
 *
 * The order object contains the payment method token generated by the
 * client that is required to process the PayPal charge.
 *
 * After successfuly processing the charge, we use the result of that
 * operation to create transactions the database, add the user as a
 * backer to the collective and update the payment method.
 *
 * @param {models.Order} order is the order object created with the
 *  order request from the user.
 * @return {models.Transaction} the transaction created in the
 *  database upon the execution of the order.
 */
async function processOrder(order) {
  const paypalTransaction = await createPayPalTransaction(order);
  const transactions = await createTransactions(order, paypalTransaction);
  await addUserToCollective(order);
  await order.update({ processedAt: new Date() });
  await order.paymentMethod.update({ confirmedAt: new Date });
  return transactions;
}

const paypalbt = {
  features: {
    recurring: true,
  },
  processOrder
};

export const oauth = {
  clientToken,
};

export default {
  types: {
    default: paypalbt,
    paypalbt
  },
  oauth,
};
