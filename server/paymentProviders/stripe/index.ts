/* eslint-disable camelcase */
import { URLSearchParams } from 'url';

import config from 'config';
import debugLib from 'debug';
import jwt from 'jsonwebtoken';
import { get } from 'lodash';

import FEATURE from '../../constants/feature';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import stripe from '../../lib/stripe';
import { addParamsToUrl } from '../../lib/utils';
import models from '../../models';

import bacsdebit from './bacsdebit';
import bancontact from './bancontact';
import creditcard from './creditcard';
import paymentintent from './payment-intent';
import { webhook } from './webhook';

const debug = debugLib('stripe');

const AUTHORIZE_URI = 'https://connect.stripe.com/oauth/authorize';

export default {
  // Payment Method types implemented using Stripe
  types: {
    // eslint-disable-next-line camelcase
    bacs_debit: bacsdebit,
    bancontact: bancontact,
    default: creditcard,
    creditcard,
    paymentintent,
    // eslint-disable-next-line camelcase
    us_bank_account: paymentintent,
    // eslint-disable-next-line camelcase
    sepa_debit: paymentintent,
  },

  oauth: {
    // Returns the redirectUrl to connect the Stripe Account to the Host Collective Id
    redirectUrl: async (remoteUser, CollectiveId, query) => {
      // Since we pass the redirectUrl in clear to the frontend, we cannot pass the CollectiveId in the state query variable
      // It would be trivial to change that value and attach a Stripe Account to someone else's collective
      // That's why we encode the state in a JWT
      const state = jwt.sign(
        {
          CollectiveId,
          CreatedByUserId: remoteUser.id,
          redirect: query.redirect,
        },
        config.keys.opencollective.jwtSecret,
        {
          expiresIn: '45m', // People may need some time to set up their Stripe Account if they don't have one already
        },
      );

      const params = new URLSearchParams({
        response_type: 'code',
        scope: 'read_write',
        client_id: config.stripe.clientId,
        redirect_uri: config.stripe.redirectUri,
        state,
      });

      return `${AUTHORIZE_URI}?${params.toString()}`;
    },

    // callback called by Stripe after the user approves the connection
    callback: async (req, res, next) => {
      let state;
      debug('req.query', JSON.stringify(req.query, null, '  '));
      try {
        state = jwt.verify(req.query.state, config.keys.opencollective.jwtSecret);
      } catch (e) {
        return next(new errors.BadRequest(`Invalid JWT: ${e.message}`));
      }
      debug('state', state);
      const { CollectiveId, CreatedByUserId, redirect } = state;

      if (req.query.error === 'access_denied') {
        return res.redirect(redirect);
      }

      if (!CollectiveId) {
        return next(new errors.BadRequest('No state in the callback'));
      }

      let redirectUrl = redirect;
      try {
        const collective = await models.Collective.findByPk(CollectiveId);
        redirectUrl = redirectUrl || `${config.host.website}/${collective.slug}`;
        await models.ConnectedAccount.destroy({
          where: {
            service: 'stripe',
            CollectiveId,
          },
        });

        const token = await stripe.oauth.token({
          grant_type: 'authorization_code',
          code: req.query.code,
        });
        const data = await stripe.accounts.retrieve(token.stripe_user_id);
        const connectedAccount = await models.ConnectedAccount.create({
          service: 'stripe',
          CollectiveId,
          CreatedByUserId,
          username: token.stripe_user_id,
          token: token.access_token,
          refreshToken: token.refresh_token,
          data: {
            publishableKey: token.stripe_publishable_key,
            tokenType: token.token_type,
            scope: token.scope,
            account: data,
          },
        });

        if (!connectedAccount) {
          console.error('>>> updateHost: error: no connectedAccount');
          reportMessageToSentry(`updateHost: error: no connectedAccount`, { extra: { CollectiveId } });
        }

        const { account } = connectedAccount.data;
        const location = await collective.getLocation();

        if (!location?.structured && account.legal_entity) {
          const {
            address: { line1: address1, line2: address2, country, state: zone, city, postal_code: postalCode },
          } = account.legal_entity;

          await collective.setLocation({
            country,
            structured: {
              address1,
              address2,
              city,
              zone,
              postalCode,
            },
          });
        }

        try {
          await collective.setCurrency(account.default_currency.toUpperCase());
        } catch (error) {
          logger.error(`Unable to set currency for '${collective.slug}': ${error.message}`);
          reportErrorToSentry(error, { extra: { CollectiveId } });
        }

        collective.timezone = collective.timezone || account.timezone;

        await collective.save();
        redirectUrl = addParamsToUrl(redirectUrl, {
          message: 'StripeAccountConnected',
          CollectiveId: collective.id,
        });
        debug('redirectUrl', redirectUrl);
        return res.redirect(redirectUrl);
      } catch (e) {
        logger.error('Failed to connect Stripe account', e);
        reportErrorToSentry(e, { extra: { CollectiveId }, feature: FEATURE.CONNECTED_ACCOUNTS });
        if (get(e, 'data.error_description')) {
          return next(new errors.BadRequest(e.data.error_description));
        } else {
          return next(e);
        }
      }
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
