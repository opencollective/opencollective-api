import braintree from 'braintree';
import config from 'config';
import jwt from 'jsonwebtoken';

import * as constants from '../../constants/transactions';
import * as roles from '../../constants/roles';
import * as libpayments from '../../lib/payments';
import models from '../../models';
import errors from '../../lib/errors';

const gateway = braintree.connect({
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
 */
async function getOrCreateUserToken(merchantGateway, order) {
  if (!order.paymentMethod.customerId) {
    const result = await merchantGateway.customer.create({
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

async function createPayPalTransaction(order) {
  const merchantGateway = gateway;
  const paymentMethodToken = await getOrCreateUserToken(merchantGateway, order);
  const amount = order.totalAmount / 100; // PayPal uses doubles to store currency
  //const serviceFeeAmount = libpayments.calcFee(amount, constants.OC_FEE_PERCENT);

  return merchantGateway.transaction.sale({
    paymentMethodToken,
    // serviceFeeAmount,
    amount,
    options: {
      submitForSettlement: true
    }
  });
}

function formatAmountValue(amount)
{
  return parseFloat(amount) * 100;
}

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

export default {
  types: {
    default: paypalbt,
    paypalbt
  },
  oauth: {
    clientToken,
  },
};
