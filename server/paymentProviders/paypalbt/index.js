import braintree from 'braintree';
import config from 'config';
import jwt from 'jsonwebtoken';

import * as constants from '../../constants/transactions';
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
    console.log(result);
    order.paymentMethod.update({
      customerId: result.customer.id,
      token: result.customer.paymentMethods[0].token,
    });
  }
  return order.paymentMethod.token;
}

async function createTransactions(order) {
  const merchantGateway = gateway;
  const paymentMethodToken = await getOrCreateUserToken(merchantGateway, order);
  const amount = order.totalAmount / 100; // PayPal uses doubles to store currency
  //const serviceFeeAmount = libpayments.calcFee(amount, constants.OC_FEE_PERCENT);

  const result = await merchantGateway.transaction.sale({
    merchantAccountId: merchantAccount.clientId,
    paymentMethodToken,
    // serviceFeeAmount,
    amount,
    options: {
      submitForSettlement: true
    }
  });
}

async function processOrder(order) {
  await createTransactions(order);
  // await order.update({ processedAt: new Date() });
  // await order.paymentMethod.update({ confirmedAt: new Date });
  // return transactions;
  return null;
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
