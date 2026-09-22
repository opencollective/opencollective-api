import config from 'config';
import jwt from 'jsonwebtoken';
import express from 'express';

import errors from '../../lib/errors';
import logger from '../../lib/logger';
import RateLimit from '../../lib/rate-limit';
import models, { sequelize } from '../../models';
import { Collective, ConnectedAccount } from '../../models';
import PayoutMethod, { PayoutMethodTypes, PaypalPayoutMethodData } from '../../models/PayoutMethod';
import User from '../../models/User';
import { SupportedCurrency } from '../../constants/currencies';
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

type ConnectPaypalPayoutMethodParams = {
  remoteUser: User;
  collective: Collective;
  code: string;
  state: string;
  currency: SupportedCurrency;
  name?: string;
  payoutMethod?: PayoutMethod | null;
};

/**
 * Exchanges a PayPal OAuth code for tokens and creates/updates a payee ConnectedAccount + PayoutMethod.
 * Permission checks (admin of collective, state binding) are done here.
 */
export async function connectPaypalPayoutMethod({
  remoteUser,
  collective,
  code,
  state,
  currency,
  name,
  payoutMethod: initialPayoutMethod = null,
}: ConnectPaypalPayoutMethodParams): Promise<{ connectedAccount: ConnectedAccount; payoutMethod: PayoutMethod }> {
  if (!code) {
    throw new errors.BadRequest('PayPal code is missing');
  } else if (!state) {
    throw new errors.BadRequest('OAuth state is missing. Please restart the PayPal connect flow.');
  } else if (!currency) {
    throw new errors.BadRequest('Currency not provided');
  }

  let statePayload: { CollectiveId: number; userId: number };
  try {
    statePayload = jwt.verify(state, config.keys.opencollective.jwtSecret) as {
      CollectiveId: number;
      userId: number;
    };
  } catch {
    throw new errors.BadRequest('The confirmation code is invalid or expired. Please restart the PayPal connect flow.');
  }

  if (statePayload.CollectiveId !== collective.id) {
    throw new errors.Forbidden(
      'The confirmation code does not match the requested account. Please restart the PayPal connect flow.',
    );
  }
  if (statePayload.userId !== remoteUser.id) {
    throw new errors.Forbidden(
      'The OAuth state does not match the current user. Please restart the PayPal connect flow.',
    );
  }

  if (!remoteUser.isAdminOfCollective(collective)) {
    throw new errors.Forbidden('You must be an admin of this collective');
  }

  let payoutMethod: PayoutMethod | null = initialPayoutMethod;
  if (payoutMethod) {
    if (payoutMethod.CollectiveId !== collective.id) {
      throw new errors.Forbidden('The payout method is not associated with this account');
    } else if (payoutMethod.type !== PayoutMethodTypes.PAYPAL) {
      throw new errors.Forbidden('The payout method is not a PayPal payout method');
    }
  }

  const rateLimit = new RateLimit(`paypal-connect-${remoteUser.id}`, 10, 30 * 60);
  if (!(await rateLimit.registerCall())) {
    throw new errors.RateLimitExceeded('Rate limit exceeded');
  }

  try {
    const tokenResult = await exchangeAuthCodeForToken(code);
    const paypalUserInfo = await retrievePaypalUserInfo(tokenResult.access_token);

    const confirmedEmails = paypalUserInfo.emails.filter(email => email.confirmed);
    if (confirmedEmails.length === 0) {
      throw new errors.BadRequest('This PayPal account is not associated with a confirmed email address');
    } else if (paypalUserInfo.verified_account !== 'true') {
      throw new errors.BadRequest('This PayPal account is not verified');
    } else if (
      payoutMethod &&
      !confirmedEmails.find(email => email.value === (payoutMethod?.data as PaypalPayoutMethodData)?.email)
    ) {
      payoutMethod = null;
    }

    const primaryEmail: string = (confirmedEmails.find(email => email.primary) || confirmedEmails[0]).value;

    const result = await sequelize.transaction(async transaction => {
      const connectedAccount = await models.ConnectedAccount.create(
        {
          // Adding a `clientId` here would make the connected account usable for payments/payouts.
          // Make sure to introduce a new flag if you ever touch this.
          service: 'paypal',
          CollectiveId: collective.id,
          CreatedByUserId: remoteUser.id,
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
            currency,
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
            currency,
            CreatedByUserId: remoteUser.id,
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

    return result;
  } catch (e) {
    if (e instanceof errors.BadRequest || e instanceof errors.Forbidden || e instanceof errors.RateLimitExceeded) {
      throw e;
    }
    logger.error('PayPal connect (SDK flow) failed', e);
    throw new errors.ServerError('PayPal connect failed');
  }
}

const deprecatedConnectHandler = (_req: express.Request, res: express.Response): void => {
  res.sendStatus(401);
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
     * @deprecated Use getPaypalOAuthUrl GraphQL mutation.
     */
    connectConfig: deprecatedConnectHandler,

    /**
     * @deprecated Use connectPaypalPayoutMethod GraphQL mutation.
     */
    connect: deprecatedConnectHandler,
  },
};
