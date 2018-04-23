import braintree from 'braintree';
import config from 'config';
import jwt from 'jsonwebtoken';

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
  // Retrieve collective using the ID retrieved from request
  const { CollectiveId } = req.query;
  const collective = await models.Collective.findById(CollectiveId);
  if (!collective) throw new Error('Collective does not exist');

  // Get the host account
  const { service } = req.params;
  const hostCollectiveId = await collective.getHostCollectiveId();
  if (!hostCollectiveId) throw new Error('Can\'t retrieve host collective id');

  // Merchant ID of the host account
  if (!hostCollectiveId) throw new Error('Can\'t retrieve host collective id');
  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service, CollectiveId: hostCollectiveId } });
  if (!connectedAccount) throw new Error('Host does not have a paypal account');
  const { clientId, token } = connectedAccount;

  // Authenticate to braintree with the host account instead of using
  // the client connected with the platform account.
  const clientWithHostAccount = braintree.connect({
    accessToken: token,
    environment: config.paypalbt.environment,
  });

  // Generate token for the above merchant id
  try {
    const result = await clientWithHostAccount.clientToken.generate();
    res.send({ clientToken: result.clientToken });
  } catch (error) {
    res.send({ error });
  }
}

async function processOrder(order) {
  throw new Error('Not Implemented');
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
