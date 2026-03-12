import assert from 'assert';

import config from 'config';
import jwt from 'jsonwebtoken';

import { idDecode, idEncode, IDENTIFIER_TYPES } from '../../graphql/v2/identifiers';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import RateLimit from '../../lib/rate-limit';
import { reportErrorToSentry } from '../../lib/sentry';
import models, { sequelize } from '../../models';
import PayoutMethod, { PayoutMethodTypes, PaypalPayoutMethodData } from '../../models/PayoutMethod';
import { hashObject } from '../utils';

import { exchangeAuthCodeForToken, paypalConnectAuthorizeUrl, retrievePaypalUserInfo } from './api';
import payment from './payment';
import subscription from './subscription';

/**
 * PayPal paymentProvider
 * Supports payment and subscription types, and "Log in with PayPal" OAuth for payees.
 */

// Scopes requested from the PayPal Identity API:
// - openid: required base scope
// - email: user's email address
// - https://uri.paypal.com/services/paypalattributes: account verification status + Payer ID
const PAYPAL_CONNECT_SCOPES = ['openid', 'email', 'https://uri.paypal.com/services/paypalattributes'].join(' ');

const getRedirectUrl = (remoteUser, CollectiveId, query): string => {
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

  return `${paypalConnectAuthorizeUrl()}?${params.toString()}`;
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
     * Returns the PayPal Connect public client ID (if configured on this platform).
     * GET /connected-accounts/paypal/connect-config
     * Returns: { clientId: string } or 404 if not configured.
     */
    connectConfig: async (req, res, next) => {
      const clientId = config.paypal?.connect?.clientId;
      if (!clientId) {
        return res.status(404).json({ error: 'PayPal Connect is not available at the moment.' });
      }

      if (!req.remoteUser) {
        return next(new errors.Unauthorized('You must be logged in'));
      } else if (!req.query.accountId) {
        return next(new errors.BadRequest('Missing accountId'));
      } else if (!req.query.redirect) {
        return next(new errors.BadRequest('Missing redirect'));
      }

      const collectiveId = idDecode(req.query.accountId, IDENTIFIER_TYPES.ACCOUNT);
      const collective = await models.Collective.findByPk(collectiveId);
      if (!collective) {
        return next(new errors.NotFound('Collective not found'));
      } else if (!req.remoteUser.isAdminOfCollective(collective)) {
        return next(new errors.Forbidden('You must be an admin of this collective'));
      }

      return res.json({
        clientId,
        redirectUri: config.paypal?.connect?.redirectUri,
        authorizeUrl: getRedirectUrl(req.remoteUser, collective.id, req.query),
      });
    },

    /**
     * JSON endpoint for the PayPal SDK button flow.
     * The SDK calls back with an auth code directly in the browser; this endpoint
     * exchanges it for tokens, upserts the ConnectedAccount, and returns JSON.
     *
     * POST /connected-accounts/paypal/connect
     * Body: { code: string, accountId: string, payoutMethodId: string, currency: string, name: string }
     * Returns: { connectedAccountId: number, email: string }
     */
    connect: async (req, res, next) => {
      if (!req.remoteUser) {
        return next(new errors.Unauthorized('You must be logged in'));
      }

      const { code, accountId, payoutMethodId, currency, name } = req.body;
      if (!accountId) {
        return next(new errors.BadRequest('Account ID is missing'));
      } else if (!code) {
        return next(new errors.BadRequest('PayPal code is missing'));
      } else if (!currency) {
        return next(new errors.BadRequest('Currency not provided'));
      }

      // Ensure the remote user is an admin of the collective
      const collectiveId = idDecode(accountId, IDENTIFIER_TYPES.ACCOUNT);
      const collective = await models.Collective.findByPk(collectiveId);
      if (!collective) {
        return next(new errors.NotFound('Collective not found'));
      } else if (!req.remoteUser.isAdminOfCollective(collective)) {
        return next(new errors.Forbidden('You must be an admin of this collective'));
      }

      // Load & check payout method ID if provided
      let payoutMethod: PayoutMethod | null = null;
      if (payoutMethodId) {
        payoutMethod = await models.PayoutMethod.findByPk(idDecode(payoutMethodId, IDENTIFIER_TYPES.PAYOUT_METHOD));
        if (!payoutMethod) {
          return next(new errors.NotFound('Payout method not found'));
        } else if (payoutMethod.CollectiveId !== collective.id) {
          return next(new errors.Forbidden('The payout method is not associated with this account'));
        } else if (payoutMethod.type !== PayoutMethodTypes.PAYPAL) {
          return next(new errors.Forbidden('The payout method is not a PayPal payout method'));
        }
      }

      // Rate limit
      const rateLimit = new RateLimit(`paypal-connect-${req.remoteUser.id}`, 10, 30 * 60);
      if (!(await rateLimit.registerCall())) {
        return next(new errors.RateLimitExceeded('Rate limit exceeded'));
      }

      try {
        // Retrieve info from PayPal
        const tokenResult = await exchangeAuthCodeForToken(code);
        const paypalUserInfo = await retrievePaypalUserInfo(tokenResult.access_token);

        // Paypal supports multiple emails per account. We only keep the confirmed ones, and default to the "primary" one.
        const confirmedEmails = paypalUserInfo.emails.filter(email => email.confirmed);
        if (confirmedEmails.length === 0) {
          throw new errors.BadRequest('This PayPal account is not associated with a confirmed email address');
        } else if (paypalUserInfo.verified_account !== 'true') {
          throw new errors.BadRequest('This PayPal account is not verified');
        } else if (
          payoutMethod &&
          !confirmedEmails.find(email => email.value === (payoutMethod?.data as PaypalPayoutMethodData)?.email)
        ) {
          // This error is likely to happen when people will try to "confirm" their legacy PayPal payout methods, but end up
          // linking a new PayPal account setup with a different email address. Rather than forcing them through the full flow again,
          // we silently ignore the existing payout method and create a new one.
          payoutMethod = null;

          // If we ever want to enforce this, we can uncomment the following code and return a 403 error:
          // return next(
          //   new errors.Forbidden(
          //     'The connected PayPal account does not match the registered email address. To connect a new PayPal account, select the "New payout method" option.',
          //   ),
          // );
        }

        const primaryEmail: string = (confirmedEmails.find(email => email.primary) || confirmedEmails[0]).value;

        // At this stage, the account is verified. We can directly create the ConnectedAccount + PayoutMethod.
        const result = await sequelize.transaction(async transaction => {
          const connectedAccount = await models.ConnectedAccount.create(
            {
              service: 'paypal',
              CollectiveId: collective.id,
              CreatedByUserId: req.remoteUser.id,
              username: primaryEmail,
              token: tokenResult.access_token,
              refreshToken: tokenResult.refresh_token,
              hash: hashObject({
                CollectiveId: collective.id,
                service: 'paypal-connect',
                payerId: paypalUserInfo.user_id,
              }),
              data: {
                payerId: paypalUserInfo.user_id,
              },
            },
            {
              transaction,
            },
          );

          if (payoutMethod) {
            await payoutMethod.update(
              {
                data: {
                  isPayPalOAuth: true,
                  verifiedAt: new Date().toISOString(),
                  currency: currency,
                  email: primaryEmail,
                  connectedAccountId: connectedAccount.id,
                  paypalUserInfo,
                },
              },
              {
                transaction,
              },
            );
          } else {
            payoutMethod = await models.PayoutMethod.create(
              {
                type: PayoutMethodTypes.PAYPAL,
                name: name || primaryEmail,
                isSaved: true,
                CreatedByUserId: req.remoteUser.id,
                CollectiveId: collective.id,
                data: {
                  isPayPalOAuth: true,
                  verifiedAt: new Date().toISOString(),
                  currency,
                  email: primaryEmail,
                  connectedAccountId: connectedAccount.id,
                  paypalUserInfo,
                },
              },
              {
                transaction,
              },
            );
          }

          return { connectedAccount, payoutMethod };
        });

        const connectedAccountId = idEncode(result.connectedAccount.id, IDENTIFIER_TYPES.CONNECTED_ACCOUNT);
        const payoutMethodId = idEncode(result.payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
        return res.json({ connectedAccountId, payoutMethodId });
      } catch (e) {
        logger.error('PayPal connect (SDK flow) failed', e);
        reportErrorToSentry(e, { req });
        return next(e);
      }
    },
  },
};
