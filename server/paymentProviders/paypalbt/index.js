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
    scope: "read_write",
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
    username: merchantId,
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

const paypalBt = null;

export default {
  types: {
    default: paypalBt,
    paypalBt
  },
  oauth: {
    redirectUrl: oauthRedirectUrl,
    callback: oauthCallback,
  },
};
