import config from 'config';
import jwt from 'jsonwebtoken';

import { SupportedCurrency } from '../../constants/currencies';
import FEATURE from '../../constants/feature';
import {
  ApolloError,
  BadRequest,
  Forbidden,
  RateLimitExceeded,
  UnexpectedError,
  ValidationFailed,
} from '../../graphql/errors';
import logger from '../../lib/logger';
import RateLimit from '../../lib/rate-limit';
import { reportErrorToSentry } from '../../lib/sentry';
import models, { Collective, ConnectedAccount, sequelize } from '../../models';
import PayoutMethod, { PayoutMethodTypes, PaypalPayoutMethodData } from '../../models/PayoutMethod';
import User from '../../models/User';
import { hashObject } from '../utils';

import { exchangeAuthCodeForToken, paypalConnectAuthorizeUrl, retrievePaypalUserInfo } from './api';
import { isPayPalSupportedCurrency } from './constants';
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

const getRedirectUrl = (remoteUser: User, CollectiveId: number, { currency }: { currency?: string } = {}): string => {
  const state = jwt.sign(
    {
      CollectiveId,
      userId: remoteUser.id,
      currency: currency || 'USD',
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
  /** Used to add the request context to Sentry reports */
  req?: Express.Request;
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
  req,
}: ConnectPaypalPayoutMethodParams): Promise<{ connectedAccount: ConnectedAccount; payoutMethod: PayoutMethod }> {
  if (!code) {
    throw new ValidationFailed('PayPal code is missing');
  } else if (!state) {
    throw new ValidationFailed('OAuth state is missing. Please restart the PayPal connect flow.');
  } else if (!currency) {
    throw new ValidationFailed('Currency not provided');
  } else if (!isPayPalSupportedCurrency(currency)) {
    throw new ValidationFailed('This currency is not supported by PayPal');
  }

  let statePayload: { CollectiveId: number; userId: number };
  try {
    statePayload = jwt.verify(state, config.keys.opencollective.jwtSecret) as {
      CollectiveId: number;
      userId: number;
    };
  } catch {
    throw new BadRequest('The confirmation code is invalid or expired. Please restart the PayPal connect flow.');
  }

  if (statePayload.CollectiveId !== collective.id) {
    throw new Forbidden(
      'The confirmation code does not match the requested account. Please restart the PayPal connect flow.',
    );
  }
  if (statePayload.userId !== remoteUser.id) {
    throw new Forbidden('The OAuth state does not match the current user. Please restart the PayPal connect flow.');
  }

  if (!remoteUser.isAdminOfCollective(collective)) {
    throw new Forbidden('You must be an admin of this collective');
  }

  let payoutMethod: PayoutMethod | null = initialPayoutMethod;
  if (payoutMethod) {
    if (payoutMethod.CollectiveId !== collective.id) {
      throw new Forbidden('The payout method is not associated with this account');
    } else if (payoutMethod.type !== PayoutMethodTypes.PAYPAL) {
      throw new Forbidden('The payout method is not a PayPal payout method');
    }
  }

  const rateLimit = new RateLimit(`paypal-connect-${remoteUser.id}`, 10, 30 * 60);
  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded();
  }

  try {
    const tokenResult = await exchangeAuthCodeForToken(code);
    const paypalUserInfo = await retrievePaypalUserInfo(tokenResult.access_token);

    // Paypal supports multiple emails per account. We only keep the confirmed ones, and default to the "primary" one.
    const confirmedEmails = paypalUserInfo.emails.filter(email => email.confirmed);
    if (confirmedEmails.length === 0) {
      throw new BadRequest('This PayPal account is not associated with a confirmed email address');
    } else if (paypalUserInfo.verified_account !== 'true') {
      throw new BadRequest('This PayPal account is not verified');
    } else if (
      payoutMethod &&
      !confirmedEmails.find(email => email.value === (payoutMethod?.data as PaypalPayoutMethodData)?.email)
    ) {
      // This is likely to happen when people try to "confirm" their legacy PayPal payout methods, but end up
      // linking a PayPal account set up with a different email address. Rather than forcing them through the full
      // flow again, we silently ignore the existing payout method and create a new one.
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
            ConnectedAccountId: connectedAccount.id,
            data: {
              isPayPalOAuth: true,
              verifiedAt: new Date().toISOString(),
              currency: currency,
              email: primaryEmail,
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
            ConnectedAccountId: connectedAccount.id,
            data: {
              isPayPalOAuth: true,
              verifiedAt: new Date().toISOString(),
              currency,
              email: primaryEmail,
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
    if (e instanceof ApolloError) {
      throw e;
    }

    // Report the original error, then throw a user-facing one (with a code, so it's not reported twice)
    logger.error('PayPal connect failed', e);
    reportErrorToSentry(e, {
      feature: FEATURE.PAYPAL_CONNECT,
      user: remoteUser,
      req,
      extra: { CollectiveId: collective.id, PayoutMethodId: initialPayoutMethod?.id },
    });
    throw new UnexpectedError('PayPal connect failed');
  }
}

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
  },
};
