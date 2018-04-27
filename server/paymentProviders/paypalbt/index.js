import braintree from 'braintree';
import config from 'config';
import jwt from 'jsonwebtoken';

import * as constants from '../../constants/transactions';
import * as libpayments from '../../lib/payments';
import models from '../../models';
import errors from '../../lib/errors';

const gateway = braintree.connect({
  environment: config.paypalbt.environment,
  clientId: config.paypalbt.clientId,
  clientSecret: config.paypalbt.clientSecret,
});

/** Return the URL needed by the PayPal Braintree client */
async function oauthRedirectUrl(remoteUser, CollectiveId) {
  const hostCollective = await models.Collective.findById(CollectiveId);
  const state = jwt.sign({
    CollectiveId,
    CreatedByUserId: remoteUser.id
  }, config.keys.opencollective.secret, {
    // People may need some time to set up their Paypal Account if
    // they don't have one already
    expiresIn: '45m'
  });
  return gateway.oauth.connectUrl({
    landingPage: "signup",
    loginOnly: "false",
    paymentMethods: ["credit_card", "paypal"],
    redirectUri: config.paypalbt.redirectUri,
    scope: "read_write,shared_vault_transactions",
    state,
    user: {
      first_name: remoteUser.firstName,
      last_name: remoteUser.lastName,
      email: remoteUser.email,
    },
    business: {
      name: hostCollective.name,
      currency: hostCollective.currency,
      street_address: hostCollective.address,
      locality: hostCollective.locationName,
      website: hostCollective.website,
      description: hostCollective.description,
    },
  });
}

async function oauthCallback(req, res, next) {
  let state;
  try {
    state = jwt.verify(req.query.state, config.keys.opencollective.secret);
  } catch (e) {
    return next(new errors.BadRequest(`Invalid JWT: ${e.message}`));
  }

  const { CollectiveId, CreatedByUserId } = state;

  if (!CollectiveId) {
    return next(new errors.BadRequest('No state in the callback'));
  }

  const { code, merchantId } = req.query;
  const collective = await models.Collective.findById(CollectiveId);
  const { credentials } = await gateway.oauth.createTokenFromCode({ code });
  await models.ConnectedAccount.create({
    service: 'paypalbt',
    CollectiveId,
    CreatedByUserId,
    clientId: merchantId,
    token: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    data: {
      expiresAt: credentials.expiresAt,
      tokenType: credentials.tokenType,
      scope: credentials.scope
    }
  });

  const url = `${config.host.website}/${collective.slug}?message=PayPalBtAccountConnected`;
  return res.redirect(url);
}

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
    const merchantAccount = await getMerchantAccount(collective);
    const merchantGateway = await getMerchantGateway(merchantAccount);
    const result = await merchantGateway.clientToken.generate();
    return res.send({ clientToken: result.clientToken });
  } catch (error) {
    return next(error);
  }
}

/** Retrieve connected account of the host
 *
 * The connected account of the host contains the token to
 * authenticate as a gateway as well as the host's merchant id.
 *
 * @param {models.Collective} collective is an instance of the
 *  collective model that will have its host data retrieved.
 * @return {models.ConnectedAccount} the instance of the connected
 *  account that contains the merchant id in the field `clientId` and
 *  the gateway access token in the field `token`.
 */
async function getMerchantAccount(collective) {
  const hostCollectiveId = await collective.getHostCollectiveId();
  if (!hostCollectiveId) throw new errors.BadRequest('Can\'t retrieve host collective id');
  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service: 'paypalbt', CollectiveId: hostCollectiveId } });
  if (!connectedAccount) throw new errors.BadRequest('Host does not have a paypal account');
  return connectedAccount;
}

/** Return a Braintree gateway connected as a merchant.
 *
 * @param {models.ConnectAccount} merchantAccount is the db instance
 *  that contains the data about the host that will be used to create
 *  the gateway.
 */
async function getMerchantGateway(merchantAccount) {
  return braintree.connect({
    accessToken: merchantAccount.token,
    environment: config.paypalbt.environment,
  });
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
  const merchantAccount = await getMerchantAccount(order.collective);
  const merchantGateway = await getMerchantGateway(merchantAccount);
  const paymentMethodToken = await getOrCreateUserToken(merchantGateway, order);

  const amount = order.totalAmount / 100; // PayPal uses doubles to store currency
  const serviceFeeAmount = libpayments.calcFee(amount, constants.OC_FEE_PERCENT);

  const result = await merchantGateway.transaction.sale({
    merchantAccountId: merchantAccount.clientId,
    paymentMethodToken,
    serviceFeeAmount,
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
    redirectUrl: oauthRedirectUrl,
    callback: oauthCallback,
    clientToken,
  },
};
