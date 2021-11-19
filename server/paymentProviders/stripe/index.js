import { URLSearchParams } from 'url';

import axios from 'axios';
import config from 'config';
import debugLib from 'debug';
import jwt from 'jsonwebtoken';
import { get } from 'lodash';

import errors from '../../lib/errors';
import logger from '../../lib/logger';
import stripe from '../../lib/stripe';
import { addParamsToUrl } from '../../lib/utils';
import models from '../../models';

import alipay from './alipay';
import creditcard from './creditcard';
import { processAuthorization, processTransaction } from './virtual-cards';

const debug = debugLib('stripe');

const AUTHORIZE_URI = 'https://connect.stripe.com/oauth/authorize';
const TOKEN_URI = 'https://connect.stripe.com/oauth/token';

/* eslint-disable camelcase */
const getToken = code => () =>
  axios
    .post(TOKEN_URI, {
      grant_type: 'authorization_code',
      client_id: config.stripe.clientId,
      client_secret: config.stripe.secret,
      code,
    })
    .then(res => res.data);
/* eslint-enable camelcase */

const getAccountInformation = data => {
  return new Promise((resolve, reject) => {
    return stripe.accounts.retrieve(data.stripe_user_id, (err, account) => {
      if (err) {
        return reject(err);
      }
      data.account = account;
      return resolve(data);
    });
  });
};

export default {
  // payment method types
  // like cc, btc, etc.
  types: {
    default: creditcard,
    creditcard,
    alipay,
  },

  oauth: {
    // Returns the redirectUrl to connect the Stripe Account to the Host Collective Id
    redirectUrl: (remoteUser, CollectiveId, query) => {
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

      /* eslint-disable camelcase */
      const params = new URLSearchParams({
        response_type: 'code',
        scope: 'read_write',
        client_id: config.stripe.clientId,
        redirect_uri: config.stripe.redirectUri,
        state,
      });
      /* eslint-enable camelcase */

      return Promise.resolve(`${AUTHORIZE_URI}?${params.toString()}`);
    },

    // callback called by Stripe after the user approves the connection
    callback: (req, res, next) => {
      let state, collective;
      debug('req.query', JSON.stringify(req.query, null, '  '));
      try {
        state = jwt.verify(req.query.state, config.keys.opencollective.jwtSecret);
      } catch (e) {
        return next(new errors.BadRequest(`Invalid JWT: ${e.message}`));
      }
      debug('state', state);
      const { CollectiveId, CreatedByUserId, redirect } = state;

      if (!CollectiveId) {
        return next(new errors.BadRequest('No state in the callback'));
      }

      let redirectUrl = redirect;

      const deleteStripeAccounts = () =>
        models.ConnectedAccount.destroy({
          where: {
            service: 'stripe',
            CollectiveId,
          },
        });

      const createStripeAccount = data =>
        models.ConnectedAccount.create({
          service: 'stripe',
          CollectiveId,
          CreatedByUserId,
          username: data.stripe_user_id,
          token: data.access_token,
          refreshToken: data.refresh_token,
          data: {
            publishableKey: data.stripe_publishable_key,
            tokenType: data.token_type,
            scope: data.scope,
            account: data.account,
          },
        });

      /**
       * Update the Host Collective
       * with the default currency of the bank account connected to the stripe account and legal address
       * @param {*} connectedAccount
       */
      const updateHost = async connectedAccount => {
        if (!connectedAccount) {
          console.error('>>> updateHost: error: no connectedAccount');
        }

        const { account } = connectedAccount.data;
        if (!collective.address && account.legal_entity) {
          const { address } = account.legal_entity;
          const addressLines = [address.line1];
          if (address.line2) {
            addressLines.push(address.line2);
          }
          if (address.country === 'US') {
            addressLines.push(`${address.city} ${address.state} ${address.postal_code}`);
          } else if (address.country === 'UK') {
            addressLines.push(`${address.city} ${address.postal_code}`);
          } else {
            addressLines.push(`${address.postal_code} ${address.city}`);
          }

          addressLines.push(address.country);
          collective.address = addressLines.join('\n');
        }

        try {
          await collective.setCurrency(account.default_currency.toUpperCase());
        } catch (error) {
          logger.error(`Unable to set currency for '${collective.slug}': ${error.message}`);
        }

        collective.timezone = collective.timezone || account.timezone;

        return collective.save();
      };

      return models.Collective.findByPk(CollectiveId)
        .then(c => {
          collective = c;
          redirectUrl = redirectUrl || `${config.host.website}/${collective.slug}`;
        })
        .then(deleteStripeAccounts)
        .then(getToken(req.query.code))
        .then(getAccountInformation)
        .then(createStripeAccount)
        .then(updateHost)
        .then(() => {
          redirectUrl = addParamsToUrl(redirectUrl, {
            message: 'StripeAccountConnected',
            CollectiveId: collective.id,
          });
          debug('redirectUrl', redirectUrl);
          return res.redirect(redirectUrl);
        })
        .catch(e => {
          if (get(e, 'data.error_description')) {
            return next(new errors.BadRequest(e.data.error_description));
          } else {
            return next(e);
          }
        });
    },
  },

  processOrder: order => {
    switch (order.paymentMethod.type) {
      case 'bitcoin':
        throw new errors.BadRequest('Stripe-Bitcoin not supported anymore :(');
      case 'alipay':
        return alipay.processOrder(order);
      case 'creditcard': /* Fallthrough */
      default:
        return creditcard.processOrder(order);
    }
  },

  webhook: request => {
    const requestBody = request.body;

    debug(`Stripe webhook event received : ${request.rawBody}`);

    // Stripe sends test events to production as well
    // don't do anything if the event is not livemode
    // NOTE: not using config.env because of ugly tests
    if (process.env.OC_ENV === 'production' && !requestBody.livemode) {
      return Promise.resolve();
    }

    const stripeEvent = {
      signature: request.headers['stripe-signature'],
      rawBody: request.rawBody,
    };

    if (requestBody.type === 'issuing_authorization.request') {
      return processAuthorization(requestBody.data.object, stripeEvent);
    }

    if (requestBody.type === 'issuing_transaction.created') {
      return processTransaction(requestBody.data.object, stripeEvent);
    }

    /**
     * We check the event on stripe directly to be sure we don't get a fake event from
     * someone else
     */
    return stripe.events.retrieve(requestBody.id, { stripeAccount: requestBody.user_id }).then(event => {
      if (!event || (event && !event.type)) {
        throw new errors.BadRequest('Event not found');
      }
      if (event.type === 'invoice.payment_succeeded') {
        return creditcard.webhook(requestBody, event);
      } else if (event.type === 'charge.refund.updated') {
        return alipay.webhook(requestBody, event);
      } else if (event.type === 'source.chargeable') {
        /* This will cause stripe to send us email alerts, saying
         * that our stuff is broken. But that should never happen
         * since they discontinued the support. */
        throw new errors.BadRequest('Stripe-Bitcoin not supported anymore :(');
      } else {
        throw new errors.BadRequest('Wrong event type received');
      }
    });
  },
};
