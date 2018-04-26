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
    }
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

async function clientToken(req, res, next) {
  const { CollectiveId } = req.query;
  const collective = await models.Collective.findById(CollectiveId);
  if (!collective) return next(new errors.BadRequest('Collective does not exist'));
  try {
    const merchant = await getMerchantGateway(collective);
    const result = await merchant.clientToken.generate();
    return res.send({ clientToken: result.clientToken });
  } catch (error) {
    return next(error);
  }
}

async function getMerchantGateway(collective) {
  // Merchant ID of the host account
  const hostCollectiveId = await collective.getHostCollectiveId();
  if (!hostCollectiveId) throw new errors.BadRequest('Can\'t retrieve host collective id');
  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service: 'paypalbt', CollectiveId: hostCollectiveId } });
  if (!connectedAccount) throw new errors.BadRequest('Host does not have a paypal account');
  const { token } = connectedAccount;
  return braintree.connect({
    accessToken: token,
    environment: config.paypalbt.environment,
  });
}

async function getOrCreateUserToken(merchant, order) {
  if (!order.paymentMethod.customerId) {
    const result = await merchant.customer.create({
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


async function createTransactions(merchant, order) {
  const paymentMethodToken = await getOrCreateUserToken(merchant, order);
  const serviceFeeAmount = libpayments.calcFee(order.totalAmount, constants.OC_FEE_PERCENT);
  const result = await merchant.transaction.sale({
    paymentMethodToken,
    serviceFeeAmount,
    amount: order.totalAmount,
  });
  console.log(result);
}

async function processOrder(order) {
  const merchant = await getMerchantGateway(order.collective);
  await createTransactions(merchant, order);
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
