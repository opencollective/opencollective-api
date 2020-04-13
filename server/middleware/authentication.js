import { URLSearchParams } from 'url';

import config from 'config';
import debugLib from 'debug';
import jwt from 'jsonwebtoken';
import { get, isNil, omitBy } from 'lodash';
import passport from 'passport';
import request from 'request-promise';

import * as connectedAccounts from '../controllers/connectedAccounts';
import errors from '../lib/errors';
import logger from '../lib/logger';
import models from '../models';
import paymentProviders from '../paymentProviders';

const { User } = models;

const { BadRequest, CustomError, Unauthorized } = errors;

const { jwtSecret } = config.keys.opencollective;

const debug = debugLib('auth');

/**
 * Middleware related to authentication.
 *
 * Identification is provided through two vectors:
 * - api_key URL parameter which uniquely identifies an application
 * - JSON web token JWT payload which contains 3 items:
 *   - sub: user ID
 *   - scope: user scope (e.g. 'subscriptions')
 *
 * Thus:
 * - a user is identified with a JWT
 */

/**
 * Express-jwt will either force all routes to have auth and throw
 * errors for public routes. Or authorize all the routes and not throw
 * expirations errors. This is a cleaned up version of that code that only
 * decodes the token (expected behaviour).
 */
export const parseJwtNoExpiryCheck = (req, res, next) => {
  let token = req.params.access_token || req.query.access_token || req.body.access_token;
  if (!token) {
    const header = req.headers && req.headers.authorization;
    if (!header) {
      return next();
    }

    const parts = header.split(' ');
    const scheme = parts[0];
    token = parts[1];
    if (!/^Bearer$/i.test(scheme) || !token) {
      return next(new BadRequest('Format is Authorization: Bearer [token]'));
    }
  }

  jwt.verify(token, jwtSecret, (err, decoded) => {
    // JWT library either returns an error or the decoded version
    if (err && err.name === 'TokenExpiredError') {
      req.jwtExpired = true;
      req.jwtPayload = jwt.decode(token, jwtSecret); // we need to decode again
    } else if (err) {
      return next(new BadRequest(err.message));
    } else {
      req.jwtPayload = decoded;
    }

    return next();
  });
};

export const checkJwtExpiry = (req, res, next) => {
  if (req.jwtExpired) {
    return next(new CustomError(401, 'jwt_expired', 'jwt expired'));
  }

  return next();
};

/**
 * Authenticate the user using the JWT token and populates:
 *  - req.remoteUser
 *  - req.remoteUser.memberships[CollectiveId] = [roles]
 */
export const _authenticateUserByJwt = async (req, res, next) => {
  if (!req.jwtPayload) {
    next();
    return;
  }

  const userId = Number(req.jwtPayload.sub);
  const user = await User.findByPk(userId);
  if (!user) {
    logger.warn(`User id ${userId} not found`);
    next();
    return;
  }

  /**
   * Functionality for one-time login links. We check that the lastLoginAt
   * in the JWT matches the lastLoginAt in the db. If so, we allow the user
   * to log in, and update the lastLoginAt.
   */
  if (req.jwtPayload.scope === 'login') {
    if (user.lastLoginAt) {
      if (!req.jwtPayload.lastLoginAt) {
        // This should only happen with pre-migration tokens, that don't have this field.
        // Should be turned into an error in the future.
        if (config.env === 'production') {
          logger.warn('Using a token without `lastLoginAt`');
          logger.warn(req.jwtPayload);
        }
      } else if (user.lastLoginAt.getTime() !== req.jwtPayload.lastLoginAt) {
        if (config.env === 'production') {
          logger.error('This login link is expired or has already been used');
          return next(errors.Unauthorized('This login link is expired or has already been used'));
        } else {
          logger.info('This login link is expired or has already been used. Ignoring in non-production environment.');
        }
      }
    }
    await user.update({
      // The login was accepted, we can update lastLoginAt. This will invalidate all older tokens.
      lastLoginAt: new Date(),
      data: { ...user.data, lastSignInRequest: { ip: req.ip, userAgent: req.header('user-agent') } },
    });
  }

  await user.populateRoles();

  req.remoteUser = user;

  debug('logged in user', req.remoteUser.id, 'roles:', req.remoteUser.rolesByCollectiveId);
  next();
};

/**
 * Authenticate the user with the JWT token if any, otherwise continues
 *
 * @PRE: Request with a `Authorization: Bearer [token]` with a valid token
 * @POST: req.remoteUser is set to the logged in user or null if authentication failed
 * @ERROR: Will return an error if a JWT token is provided and invalid
 */
export function authenticateUser(req, res, next) {
  if (req.remoteUser && req.remoteUser.id) {
    return next();
  }

  parseJwtNoExpiryCheck(req, res, e => {
    // If a token was submitted but is invalid, we continue without authenticating the user
    if (e) {
      debug('>>> checkJwtExpiry invalid error', e);
      return next();
    }

    checkJwtExpiry(req, res, e => {
      // If a token was submitted and is expired, we continue without authenticating the user
      if (e) {
        debug('>>> checkJwtExpiry expiry error', e);
        return next();
      }
      _authenticateUserByJwt(req, res, next);
    });
  });
}

export const authenticateService = (req, res, next) => {
  const { service } = req.params;
  const { context } = req.query;
  const opts = { callbackURL: getOAuthCallbackUrl(req) };

  if (service === 'github') {
    if (context == 'createCollective') {
      opts.scope = [
        // We need this to call github.getOrgMemberships and check if the user is an admin of a given Organization
        'read:org',
      ];
    } else {
      // We try to deprecate this scope by progressively forcing a context
      opts.scope = ['user:email', 'public_repo', 'read:org'];
    }

    return passport.authenticate(service, opts)(req, res, next);
  }

  if (!req.remoteUser || !req.remoteUser.isAdmin(req.query.CollectiveId)) {
    throw new errors.Unauthorized('Please login as an admin of this collective to add a connected account');
  }

  if (!req.query.CollectiveId) {
    return next(new errors.ValidationFailed('Please provide a CollectiveId as a query parameter'));
  }

  if (paymentProviders[service]) {
    return paymentProviders[service].oauth
      .redirectUrl(req.remoteUser, req.query.CollectiveId, req.query)
      .then(redirectUrl => res.send({ redirectUrl }))
      .catch(next);
  }

  if (service === 'meetup') {
    opts.scope = 'ageless';
  }

  return passport.authenticate(service, opts)(req, res, next);
};

export const authenticateServiceCallback = (req, res, next) => {
  const { service } = req.params;

  if (get(paymentProviders, `${service}.oauth.callback`)) {
    return paymentProviders[service].oauth.callback(req, res, next);
  }

  const opts = { callbackURL: getOAuthCallbackUrl(req) };

  passport.authenticate(service, opts, async (err, accessToken, data) => {
    if (err) {
      return next(err);
    }
    if (!accessToken) {
      return res.redirect(config.host.website);
    }
    let emails;
    if (service === 'github' && !req.remoteUser) {
      emails = await getGithubEmails(accessToken);
    }
    connectedAccounts.createOrUpdate(req, res, next, accessToken, data, emails).catch(next);
  })(req, res, next);
};

export const authenticateServiceDisconnect = (req, res) => {
  connectedAccounts.disconnect(req, res);
};

function getOAuthCallbackUrl(req) {
  // eslint-disable-next-line camelcase
  const { utm_source, CollectiveId, access_token, redirect } = req.query;
  const { service } = req.params;

  // eslint-disable-next-line camelcase
  const params = new URLSearchParams(omitBy({ access_token, redirect, CollectiveId, utm_source }, isNil));

  return `${config.host.website}/api/connected-accounts/${service}/callback?${params.toString()}`;
}

function getGithubEmails(accessToken) {
  return request({
    uri: 'https://api.github.com/user/emails',
    qs: { access_token: accessToken }, // eslint-disable-line camelcase
    headers: { 'User-Agent': 'OpenCollective' },
    json: true,
  }).then(json => json.map(entry => entry.email));
}

/**
 * Check Client App
 *
 * Check Client Id if it exists
 */
export async function checkClientApp(req, res, next) {
  const apiKey = req.get('Api-Key') || req.query.apiKey || req.apiKey;
  const clientId = req.get('Client-Id') || req.query.clientId;
  if (apiKey) {
    const app = await models.Application.findOne({
      where: { type: 'apiKey', apiKey },
    });
    if (app) {
      debug('Valid Client App (apiKey)');
      req.clientApp = app;
      const collectiveId = app.CollectiveId;
      if (collectiveId) {
        req.loggedInAccount = await models.Collective.findByPk(collectiveId);
        req.remoteUser = await models.User.findOne({
          where: { CollectiveId: collectiveId },
        });
        if (req.remoteUser) {
          await req.remoteUser.populateRoles();
        }
      }
      next();
    } else {
      debug(`Invalid Client App (apiKey: ${apiKey}).`);
      next(new Unauthorized(`Invalid Api Key: ${apiKey}.`));
    }
  } else if (clientId) {
    const app = await models.Application.findOne({
      type: 'oAuth',
      where: { clientId },
    });
    if (app) {
      debug('Valid Client App');
      req.clientApp = app;
      next();
    } else {
      debug(`Invalid Client App (clientId: ${clientId}).`);
      next(new Unauthorized(`Invalid Client Id: ${clientId}.`));
    }
  } else {
    next();
    debug('No Client App');
  }
}

/**
 * Authorize api_key
 *
 * All calls should provide a valid api_key
 */
export function authorizeClientApp(req, res, next) {
  // TODO: we should remove those exceptions
  // those routes should only be accessed via the website (which automatically adds the api_key)
  const exceptions = [
    {
      method: 'GET',
      regex: /^\/collectives\/[0-9]+\/transactions\/[0-9]+\/callback\?token=.+&paymentId=.+&PayerID=.+/,
    }, // PayPal callback
    {
      method: 'GET',
      regex: /^\/collectives\/[0-9]+\/transactions\/[0-9]+\/callback\?token=.+/,
    }, // PayPal callback
    { method: 'POST', regex: /^\/webhooks\/(mailgun|stripe|transferwise)/ },
    {
      method: 'GET',
      regex: /^\/connected-accounts\/(stripe|paypal)\/callback/,
    },
    { method: 'GET', regex: /^\/services\/email\/approve\?messageId=.+/ },
    {
      method: 'GET',
      regex: /^\/services\/email\/unsubscribe\/(.+)\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9-_\.]+)\/.+/,
    },
  ];

  for (const i in exceptions) {
    if (req.method === exceptions[i].method && req.originalUrl.match(exceptions[i].regex)) {
      return next();
    }
  }

  const apiKey = req.get('Api-Key') || req.query.apiKey || req.query.api_key || req.body.api_key;
  if (req.clientApp) {
    debug('Valid Client App');
    next();
  } else if (apiKey === config.keys.opencollective.apiKey) {
    debug(`Valid API key: ${apiKey}`);
    next();
  } else if (apiKey) {
    debug(`Invalid API key: ${apiKey}`);
    next(new Unauthorized(`Invalid API key: ${apiKey}`));
  } else {
    debug('Missing API key or Client Id');
    next();
  }
}

/**
 * Makes sure that the user the is logged in and req.remoteUser is populated.
 * if we cannot authenticate the user, we directly return an Unauthorized error.
 */
export function mustBeLoggedIn(req, res, next) {
  authenticateUser(req, res, e => {
    if (e) {
      return next(e);
    }
    if (!req.remoteUser) {
      return next(new Unauthorized('User is not authenticated'));
    } else {
      return next();
    }
  });
}
