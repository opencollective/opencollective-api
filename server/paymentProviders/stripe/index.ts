/* eslint-disable camelcase */
import { URLSearchParams } from 'url';

import config from 'config';
import express from 'express';
import { random } from 'lodash';

import { sessionCache } from '../../lib/cache';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import { reportErrorToSentry } from '../../lib/sentry';
import stripe from '../../lib/stripe';
import models, { sequelize } from '../../models';
import User from '../../models/User';
import { hashObject, validateRedirectUrl } from '../utils';

import bacsdebit from './bacsdebit';
import bancontact from './bancontact';
import creditcard from './creditcard';
import paymentintent from './payment-intent';
import { webhook } from './webhook';

const AUTHORIZE_URI = 'https://connect.stripe.com/oauth/authorize';
const PROVIDER_NAME = 'stripe';
export const STATE_CACHE_PREFIX = 'stripe_oauth_';
const STATE_TTL_SECONDS = 60 * 45; // 45 minutes - users may need time to set up their Stripe Account

/**
 * Builds the Stripe OAuth authorize URL for a given state.
 */
const getOAuthAuthorizeUrl = (state: string): string => {
  const params = new URLSearchParams({
    response_type: 'code',
    scope: 'read_write',
    client_id: config.stripe.clientId,
    redirect_uri: config.stripe.redirectUri,
    state,
  });
  return `${AUTHORIZE_URI}?${params.toString()}`;
};

/**
 * Exchanges an OAuth authorization code with Stripe and creates/updates the corresponding
 * `stripe` ConnectedAccount, then synchronizes basic location/currency/timezone information
 * on the connected Collective.
 *
 * Permission checks (the user being an admin of the Collective) are expected to be done by the caller.
 */
async function connectStripeAccount({
  code,
  CollectiveId,
  CreatedByUserId,
}: {
  code: string;
  CollectiveId: number;
  CreatedByUserId: number;
}) {
  const collective = await models.Collective.findByPk(CollectiveId);
  if (!collective) {
    throw new errors.NotFound(`Could not find Collective #${CollectiveId}`);
  }

  const token = await stripe.oauth.token({
    grant_type: 'authorization_code',
    code,
  });
  const data = await stripe.accounts.retrieve(token.stripe_user_id);
  const connectedAccount = await sequelize.transaction(async transaction => {
    // Replace any existing Stripe connected account for this collective
    await models.ConnectedAccount.destroy({ where: { service: PROVIDER_NAME, CollectiveId }, transaction });
    return await models.ConnectedAccount.create(
      {
        service: PROVIDER_NAME,
        CollectiveId,
        CreatedByUserId,
        username: token.stripe_user_id,
        token: token.access_token,
        refreshToken: token.refresh_token,
        hash: hashObject({ CollectiveId, username: token.stripe_user_id }),
        data: {
          publishableKey: token.stripe_publishable_key,
          tokenType: token.token_type,
          scope: token.scope,
          account: data,
        },
      },
      { transaction },
    );
  });

  const { account: stripeAccount } = connectedAccount.data;
  const location = await collective.getLocation();

  if (!location?.structured && stripeAccount.legal_entity) {
    const {
      line1: address1,
      line2: address2,
      country,
      state: zone,
      city,
      postal_code: postalCode,
    } = stripeAccount.legal_entity.address || {};

    await collective.setLocation({
      country,
      structured: { address1, address2, city, zone, postalCode },
    });
  }

  try {
    if (stripeAccount.default_currency) {
      await collective.setCurrency(stripeAccount.default_currency.toUpperCase());
    }
  } catch (error) {
    logger.error(`Unable to set currency for '${collective.slug}': ${error.message}`);
    reportErrorToSentry(error, { extra: { CollectiveId } });
  }

  if (!collective.timezone && stripeAccount.timezone) {
    await collective.update({ timezone: stripeAccount.timezone });
  }

  return connectedAccount;
}

export default {
  // Payment Method types implemented using Stripe
  types: {
    bacs_debit: bacsdebit,
    bancontact: bancontact,
    default: creditcard,
    creditcard,
    paymentintent,
    us_bank_account: paymentintent,
    sepa_debit: paymentintent,
    link: paymentintent,
  },

  connectStripeAccount,

  oauth: {
    /**
     * Returns the Stripe Connect OAuth URL to initiate the connection flow.
     *
     * The OAuth state is a random opaque token persisted in the session cache (along with the
     * CollectiveId, the initiating UserId, and the optional redirect URL) so it cannot be tampered with.
     * This mirrors the TransferWise OAuth flow.
     */
    redirectUrl: async function (
      user: User,
      CollectiveId: string | number,
      query?: { redirect?: string },
    ): Promise<string> {
      if (!user.rolesByCollectiveId) {
        await user.populateRoles();
      }
      if (!user.isAdmin(CollectiveId)) {
        throw new Error('User must be an admin of the Collective');
      }

      if (query?.redirect) {
        validateRedirectUrl(query.redirect);
      }

      const state = hashObject({ CollectiveId, userId: user.id, nonce: random(100000) });
      await sessionCache.set(
        `${STATE_CACHE_PREFIX}${state}`,
        { CollectiveId, redirect: query?.redirect, UserId: user.id },
        STATE_TTL_SECONDS,
      );

      return getOAuthAuthorizeUrl(state);
    },

    /**
     * Legacy REST callback: the OAuth flow has been migrated to the `connectStripeAccount`
     * GraphQL mutation. Stripe now redirects directly to the frontend callback page which calls
     * the mutation, so the REST endpoint should no longer be hit.
     */
    callback: async function (_req: express.Request, res: express.Response): Promise<void> {
      res.sendStatus(401);
      return;
    },
  },

  processOrder: order => {
    switch (order.paymentMethod.type) {
      case 'bitcoin':
        throw new errors.BadRequest('Stripe-Bitcoin not supported anymore :(');
      case 'creditcard': /* Fallthrough */
      default:
        return creditcard.processOrder(order);
    }
  },

  webhook,
};
