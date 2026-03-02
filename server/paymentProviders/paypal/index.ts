import assert from 'assert';

import config from 'config';
import jwt from 'jsonwebtoken';

import { idEncode, IDENTIFIER_TYPES } from '../../graphql/v2/identifiers';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import { reportErrorToSentry } from '../../lib/sentry';
import models, { sequelize } from '../../models';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import { hashObject } from '../utils';

import { exchangeAuthCodeForToken, paypalConnectAuthorizeUrl, retrievePaypalUserInfo } from './api';
import payment from './payment';
import subscription from './subscription';

/**
 * Shared helper: exchange an auth code for tokens + identity info, then upsert a ConnectedAccount.
 * Returns { connectedAccountId, email }.
 */
async function addPaypalOAuthConnectedAccount({ code, CollectiveId, userId, currency, name }) {
  const collective = await models.Collective.findByPk(CollectiveId);
  if (!collective) {
    throw new errors.NotFound('Collective not found');
  }

  const tokenResult = await exchangeAuthCodeForToken(code);
  const userInfo = await retrievePaypalUserInfo(tokenResult.access_token);
  const confirmedEmails = userInfo.emails.filter(email => email.confirmed);
  if (confirmedEmails.length === 0) {
    throw new errors.BadRequest('This PayPal account is not associated with a confirmed email address');
  }

  const email = confirmedEmails.find(email => email.primary) || confirmedEmails[0];
  return sequelize.transaction(async transaction => {
    const connectedAccount = await models.ConnectedAccount.create(
      {
        service: 'paypal',
        CollectiveId,
        CreatedByUserId: userId,
        username: email.value,
        token: tokenResult.access_token,
        refreshToken: tokenResult.refresh_token,
        hash: hashObject({ CollectiveId, service: 'paypal-connect', payerId: userInfo.user_id }),
        data: {
          payerId: userInfo.user_id,
          verified: userInfo.verified_account,
          name: userInfo.name,
          email: email.value,
          verifiedAt: new Date().toISOString(),
        },
      },
      {
        transaction,
      },
    );

    const payoutMethod = await models.PayoutMethod.create(
      {
        type: PayoutMethodTypes.PAYPAL,
        name: name || email.value,
        isSaved: true,
        CreatedByUserId: userId,
        CollectiveId,
        data: {
          isPayPalOAuth: true,
          currency,
          email: email.value,
          connectedAccountId: connectedAccount.id,
          userInfo,
        },
      },
      {
        transaction,
      },
    );

    return { connectedAccount, payoutMethod };
  });
}

/**
 * PayPal paymentProvider
 * Supports payment and subscription types, and "Log in with PayPal" OAuth for payees.
 */

// Scopes requested from the PayPal Identity API:
// - openid: required base scope
// - email: user's email address
// - https://uri.paypal.com/services/paypalattributes: account verification status + Payer ID
const PAYPAL_CONNECT_SCOPES = ['openid', 'email', 'https://uri.paypal.com/services/paypalattributes'].join(' ');

const getRedirectUrl = (remoteUser, CollectiveId, query) => {
  const state = jwt.sign(
    {
      CollectiveId,
      userId: remoteUser.id,
      redirect: query?.redirect || null,
      currency: query?.currency || 'USD',
    },
    config.keys.opencollective.jwtSecret,
    { expiresIn: '30m' },
  );

  const params = new URLSearchParams({});
  params.set('flowEntry', 'static');
  params.set('client_id', config.paypal.connect.clientId);
  params.set('response_type', 'code');
  params.set('scope', PAYPAL_CONNECT_SCOPES);
  params.set('redirect_uri', config.paypal.connect.redirectUri);
  params.set('state', state);

  return Promise.resolve(`${paypalConnectAuthorizeUrl()}?${params.toString()}`);
};

export default {
  types: {
    default: payment,
    payment,
    subscription,
  },

  oauth: {
    /**
     * Returns the PayPal authorization URL for "Log in with PayPal".
     * The CollectiveId is embedded in a signed JWT state to prevent CSRF / tampering.
     */
    redirectUrl: getRedirectUrl,

    /**
     * Handles the PayPal OAuth callback (redirect-based flow).
     * Exchanges the code for tokens, retrieves user identity information,
     * and upserts a ConnectedAccount for the payee.
     */
    callback: async (req, res, next) => {
      let state;
      try {
        state = jwt.verify(req.query.state, config.keys.opencollective.jwtSecret);
      } catch (e) {
        return next(new errors.BadRequest(`Invalid OAuth state: ${e.message}`));
      }

      const { CollectiveId, userId, redirect, currency } = state;

      if (req.query.error === 'access_denied') {
        const redirectUrl = redirect || `${config.host.website}`;
        return res.redirect(`${redirectUrl}?paypalConnectStatus=cancelled`);
      } else if (req.query.remoteUser?.id !== userId) {
        return next(new errors.Forbidden('You are not authorized to connect this PayPal account'));
      }

      if (!CollectiveId || !req.query.code) {
        return next(new errors.BadRequest('Missing CollectiveId or authorization code'));
      }

      try {
        const { connectedAccount, payoutMethod } = await addPaypalOAuthConnectedAccount({
          code: req.query.code,
          name: req.query.name,
          CollectiveId,
          userId,
          currency,
        });

        const redirectUrl = redirect || `${config.host.website}`;
        const connectedAccountId = idEncode(connectedAccount.id, IDENTIFIER_TYPES.CONNECTED_ACCOUNT);
        const payoutMethodId = idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
        return res.redirect(
          `${redirectUrl}?paypalConnectStatus=success&connectedAccountId=${connectedAccountId}&payoutMethodId=${payoutMethodId}`,
        );
      } catch (e) {
        logger.error('PayPal OAuth callback failed', e);
        reportErrorToSentry(e, { extra: { CollectiveId } });
        return next(e);
      }
    },

    /**
     * Returns the PayPal Connect public client ID (if configured on this platform).
     * GET /connected-accounts/paypal/connect-config
     * Returns: { clientId: string } or 404 if not configured.
     */
    connectConfig: async (req, res) => {
      const clientId = config.paypal?.connect?.clientId;
      if (!clientId) {
        return res.status(404).json({ error: 'PayPal Connect is not configured' });
      }

      assert(req.remoteUser, 'You must be logged in');
      assert(req.query.CollectiveId, 'Missing CollectiveId');
      assert(req.query.redirect, 'Missing redirect');

      const collective = await models.Collective.findByPk(req.query.CollectiveId);
      assert(collective, 'Collective not found');
      assert(req.remoteUser.isAdminOfCollective(collective), 'You must be an admin of this collective');

      return res.json({
        clientId,
        redirectUri: config.paypal?.connect?.redirectUri,
        authorizeUrl: await getRedirectUrl(req.remoteUser, collective.id, req.query),
      });
    },

    /**
     * JSON endpoint for the PayPal SDK button flow.
     * The SDK calls back with an auth code directly in the browser; this endpoint
     * exchanges it for tokens, upserts the ConnectedAccount, and returns JSON.
     *
     * POST /connected-accounts/paypal/connect
     * Body: { code: string, CollectiveId: number }
     * Returns: { connectedAccountId: number, email: string }
     */
    connect: async (req, res, next) => {
      if (!req.remoteUser) {
        return next(new errors.Unauthorized('You must be logged in'));
      }

      const { code, CollectiveId } = req.body;
      if (!code || !CollectiveId) {
        return next(new errors.BadRequest('Missing code or CollectiveId'));
      }

      // Ensure the remote user is an admin of the collective
      const collective = await models.Collective.findByPk(CollectiveId);
      if (!collective) {
        return next(new errors.NotFound('Collective not found'));
      }
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        return next(new errors.Forbidden('You must be an admin of this collective'));
      }

      try {
        const { connectedAccount, payoutMethod } = await addPaypalOAuthConnectedAccount({
          code,
          CollectiveId,
          userId: req.remoteUser.id,
          currency: req.body.currency,
          name: req.body.name,
        });

        const connectedAccountId = idEncode(connectedAccount.id, IDENTIFIER_TYPES.CONNECTED_ACCOUNT);
        const payoutMethodId = idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
        return res.json({ connectedAccountId, payoutMethodId });
      } catch (e) {
        logger.error('PayPal connect (SDK flow) failed', e);
        reportErrorToSentry(e, { extra: { CollectiveId } });
        return next(e);
      }
    },
  },
};
