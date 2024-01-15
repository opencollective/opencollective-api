import { URLSearchParams } from 'url';

import config from 'config';
import debugLib from 'debug';
import gqlmin from 'gqlmin';
import { get, isNil, omitBy, pick } from 'lodash';
import moment from 'moment';
import passport from 'passport';

import * as connectedAccounts from '../controllers/connectedAccounts';
import { verifyJwt } from '../lib/auth';
import errors from '../lib/errors';
import logger from '../lib/logger';
import { clearRedirectCookie, setRedirectCookie } from '../lib/redirect-cookie';
import { reportMessageToSentry } from '../lib/sentry';
import { TWITTER_SCOPES } from '../lib/twitter';
import { getBearerTokenFromRequestHeaders, parseToBoolean } from '../lib/utils';
import models from '../models';
import paymentProviders from '../paymentProviders';

const { User, UserToken } = models;

const { CustomError, Unauthorized } = errors;

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
const parseJwt = req => {
  let token = req.params.access_token || req.query.access_token || req.body.access_token;
  if (!token) {
    token = getBearerTokenFromRequestHeaders(req);
  }

  if (token) {
    try {
      return verifyJwt(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new CustomError(401, 'jwt_expired', 'jwt expired');
      } else {
        // If a token was submitted but is invalid, we continue without authenticating the user
        // NOTE: This is historical behavior and could be reconsidered.
        return;
        // throw new BadRequest(err.message);
      }
    }
  }
};

const checkJwtScope = req => {
  const errorMessage = `Cannot use this token on this route (scope: ${req.jwtPayload.scope})`;

  const scope = req.jwtPayload.scope || 'session';

  const path = req.originalUrl || req.path;

  switch (scope) {
    case 'twofactorauth':
      if (!path.startsWith('/users/two-factor-auth')) {
        throw new errors.Unauthorized(errorMessage);
      }
      break;

    case 'connected-account':
      if (!path.startsWith('/github-repositories') && !path.startsWith('/connected-accounts/github/verify')) {
        throw new errors.Unauthorized(errorMessage);
      }
      break;

    case 'login':
      if (!path.startsWith('/users/exchange-login-token')) {
        if (['production', 'staging'].includes(config.env)) {
          throw new errors.Unauthorized(errorMessage);
        } else {
          logger.info(`${errorMessage}. Ignoring in non-production environment.`);
        }
      }
      break;

    case 'reset-password':
      {
        const minifiedGraphqlOperation = req.body?.query ? gqlmin(req.body.query) : null;
        const allowedResetPasswordGraphqlOperations = [
          'query ResetPasswordAccount{loggedInAccount{id type slug name email imageUrl __typename}}',
          'mutation ResetPassword($password:String!){setPassword(password:$password){individual{id __typename}token __typename}}',
        ];
        if (
          // We verify that the mutation is exactly the one we expect
          !req.isGraphQL ||
          !minifiedGraphqlOperation ||
          !allowedResetPasswordGraphqlOperations.includes(minifiedGraphqlOperation)
        ) {
          throw new errors.Unauthorized(
            'Not allowed to use tokens with reset-password scope on anything else than the ResetPassword allowed GraphQL operations',
          );
        }
      }

      break;

    case 'oauth':
    case 'session':
      // No generic check

      // In other places, OAuth tokens will be prevented to:
      // - use GraphQL v1
      // - refreshToken to get a session token
      break;

    default:
      // Unknown scope
      throw new errors.Unauthorized(errorMessage);
  }
};

/**
 * Authenticate the user using the JWT token and populates:
 *  - req.remoteUser
 *  - req.remoteUser.memberships[CollectiveId] = [roles]
 */
const _authenticateUserByJwt = async (req, res, next) => {
  const userId = Number(req.jwtPayload.sub);
  const user = await User.findByPk(userId, {
    include: [{ association: 'collective', required: false }],
  });
  if (!user) {
    logger.warn(`User id ${userId} not found`);
    next();
    return;
  } else if (!user.collective) {
    logger.error(`User id ${userId} has no collective linked`);
    reportMessageToSentry(`User has no collective linked`, { user });
    next();
    return;
  }

  const { earlyAccess = {} } = user.collective.settings || {};
  if (
    earlyAccess.dashboard ||
    (parseToBoolean(config.features.dashboard.redirect) && earlyAccess.dashboard !== false)
  ) {
    setRedirectCookie(res);
  } else {
    clearRedirectCookie(res);
  }

  // Make tokens expire on password update
  const iat = moment(req.jwtPayload.iat * 1000);
  if (user.passwordUpdatedAt && moment(user.passwordUpdatedAt).diff(iat, 'seconds') > 0) {
    const errorMessage = 'This token is expired';
    logger.warn(errorMessage);
    return next(new errors.Unauthorized(errorMessage));
  }

  const accessToken = req.jwtPayload.access_token;
  if (accessToken) {
    const userToken = await UserToken.findOne({ where: { accessToken } });
    if (!userToken) {
      logger.warn(`UserToken for ${userId} not found`);
      next();
      return;
    }
    const now = moment();
    // Check token expiration
    if (userToken.accessTokenExpiresAt && now.diff(moment(userToken.accessTokenExpiresAt), 'seconds') > 0) {
      logger.warn(`UserToken expired for ${userId}`);
      next();
      return;
    }
    // Update lastUsedAt if lastUsedAt older than 1 minute ago
    if (!userToken.lastUsedAt || now.diff(moment(userToken.lastUsedAt), 'minutes') > 1) {
      if (!parseToBoolean(config.database.readOnly)) {
        await userToken.update({ lastUsedAt: new Date() });
      }
    }
    req.userToken = userToken;
  }

  // Extra checks for `login` and `reset-password` scopes
  if (req.jwtPayload.scope === 'login') {
    if (user.lastLoginAt) {
      if (!req.jwtPayload.lastLoginAt || user.lastLoginAt.getTime() !== req.jwtPayload.lastLoginAt) {
        const errorMessage = 'This login link is expired or has already been used';
        if (['production', 'staging'].includes(config.env)) {
          logger.warn(errorMessage);
          return next(new errors.Unauthorized(errorMessage));
        } else {
          logger.info(`${errorMessage}. Ignoring in non-production environment.`);
        }
      }
    } else {
      // Verify any Expenses marked as UNVERIFIED that were created before the login link was generated
      await models.Expense.verifyUserExpenses(user);
    }
  } else if (req.jwtPayload.scope === 'reset-password' && user.passwordUpdatedAt) {
    if (!req.jwtPayload.passwordUpdatedAt || user.passwordUpdatedAt.getTime() !== req.jwtPayload.passwordUpdatedAt) {
      const errorMessage = 'This reset password token is expired or has already been used';
      logger.warn(errorMessage);
      return next(new errors.Unauthorized(errorMessage));
    }
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

  try {
    req.jwtPayload = parseJwt(req);
  } catch (e) {
    debug('>>> parseJwt invalid error', e);
    return next(e);
  }

  if (!req.jwtPayload) {
    return next();
  }

  try {
    checkJwtScope(req);
  } catch (e) {
    debug('>>> checkJwtScope error', e);
    return next(e);
  }

  _authenticateUserByJwt(req, res, next);
}

export const authenticateService = (req, res, next) => {
  const { service } = req.params;
  const { context } = req.query;
  const opts = { callbackURL: getOAuthCallbackUrl(req) };

  if (service === 'github') {
    if (context === 'createCollective') {
      opts.scope = [
        // We need this to call github.getOrgMemberships and check if the user is an admin of a given Organization
        'read:org',
        // We need this for the `github.getValidatorInfo` query
        'public_repo',
      ];
    } else {
      // We try to deprecate this scope by progressively forcing a context
      opts.scope = ['user:email', 'public_repo', 'read:org'];
    }

    return passport.authenticate(service, opts)(req, res, next);
  } else if (service === 'twitter') {
    opts.scope = TWITTER_SCOPES;
  }

  if (!req.query.CollectiveId) {
    return next(new errors.ValidationFailed(undefined, 'CollectiveId', 'Please provide a CollectiveId'));
  } else if (!req.remoteUser || !req.remoteUser.isAdmin(req.query.CollectiveId)) {
    return next(new errors.Unauthorized('Please login as an admin of this collective to add a connected account'));
  }

  if (paymentProviders[service]) {
    return paymentProviders[service].oauth
      .redirectUrl(req.remoteUser, req.query.CollectiveId, req.query)
      .then(redirectUrl => res.send({ redirectUrl }))
      .catch(next);
  }

  return passport.authenticate(service, opts)(req, res, next);
};

export const authenticateServiceCallback = async (req, res, next) => {
  const { service } = req.params;
  if (get(paymentProviders, `${service}.oauth.callback`)) {
    return paymentProviders[service].oauth.callback(req, res, next);
  }

  const opts = { callbackURL: getOAuthCallbackUrl(req) };

  // Twitter redirects us here, but we redirect to the frontend before authenticating to make
  // sure the user is logged in.
  if (service === 'twitter') {
    if (!req.remoteUser && req.query.CollectiveId) {
      const collective = await models.Collective.findByPk(req.query.CollectiveId);
      if (!collective) {
        return next(new errors.NotFound('Collective not found'));
      } else {
        // Permissions will be checked in the callback
        const redirectUrl = new URL(`${config.host.website}/${collective.slug}/admin/connected-accounts`);
        redirectUrl.searchParams.set('service', service);
        redirectUrl.searchParams.set('state', req.query.state);
        redirectUrl.searchParams.set('code', req.query.code);
        redirectUrl.searchParams.set('callback', 'true');
        return res.redirect(redirectUrl.href);
      }
    } else if (!req.query.CollectiveId) {
      return next(new errors.ValidationFailed('Please provide a CollectiveId as a query parameter'));
    }
  }

  return passport.authenticate(service, opts, async (err, accessToken, data) => {
    if (err) {
      return next(err);
    } else if (!accessToken) {
      return next(new errors.Unauthorized('No access token returned from OAuth provider'));
    }

    return connectedAccounts.createOrUpdate(req, res, next, accessToken, data).catch(next);
  })(req, res, next);
};

export const authenticateServiceDisconnect = (req, res) => {
  connectedAccounts.disconnect(req, res);
};

function getOAuthCallbackUrl(req) {
  const { service } = req.params;

  // TODO We should not pass `access_token` to 3rd party services. Github likely still relies on this, but we can already remove it for Twitter.
  const params = new URLSearchParams(omitBy(pick(req.query, ['access_token', 'context', 'CollectiveId']), isNil));
  if (service === 'twitter') {
    params.delete('access_token');
  }

  // When testing with Twitter, makes sure `website` is set to `127.0.0.1`, not `locahost`
  if (params.toString().length > 0) {
    return `${config.host.website}/api/connected-accounts/${service}/callback?${params.toString()}`;
  } else {
    return `${config.host.website}/api/connected-accounts/${service}/callback`;
  }
}

/**
 * Check Personal Token
 */
export async function checkPersonalToken(req, res, next) {
  const apiKey = req.get('Api-Key') || req.query.apiKey || req.apiKey;
  const token = req.get('Personal-Token') || req.query.personalToken;

  if (apiKey || token) {
    const now = moment();
    const personalToken = await models.PersonalToken.findOne({ where: { token: apiKey || token } });
    if (personalToken) {
      if (personalToken.expiresAt && now.diff(moment(personalToken.expiresAt), 'seconds') > 0) {
        debug(`Expired Personal Token (Api Key): ${apiKey || token}`);
        next(new Unauthorized(`Expired Personal Token (Api Key): ${apiKey || token}`));
      }
      debug('Valid Personal Token (Api Key)');
      // Update lastUsedAt if lastUsedAt older than 1 minute ago
      if (!personalToken.lastUsedAt || now.diff(moment(personalToken.lastUsedAt), 'minutes') > 1) {
        if (!parseToBoolean(config.database.readOnly)) {
          await personalToken.update({ lastUsedAt: new Date() });
        }
      }
      req.personalToken = personalToken;
      const collectiveId = personalToken.CollectiveId;
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
      clearRedirectCookie(res);
      debug(`Invalid Personal Token (Api Key): ${apiKey || token}`);
      next(new Unauthorized(`Invalid Personal Token (Api Key): ${apiKey || token}`));
    }
  } else {
    clearRedirectCookie(res);
    next();
    debug('No Personal Token (Api Key)');
  }
}

/**
 * Authorize api_key
 */
export function authorizeClient(req, res, next) {
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
    {
      method: 'GET',
      regex: /^\/services\/email\/unsubscribe\/(.+)\/([a-zA-Z0-9-_]+)\/([a-zA-Z0-9-_\.]+)\/.+/,
    },
  ];

  for (const exception of exceptions) {
    if (req.method === exception.method && req.originalUrl.match(exception.regex)) {
      return next();
    }
  }

  if (req.personalToken) {
    debug('Valid Personal Token');
    next();
    return;
  }

  const apiKey = req.get('Api-Key') || req.query.apiKey || req.query.api_key || req.body.api_key;
  if (apiKey === config.keys.opencollective.apiKey) {
    debug(`Valid API key: ${apiKey}`);
    next();
  } else if (apiKey) {
    debug(`Invalid API key: ${apiKey}`);
    next(new Unauthorized(`Invalid API key: ${apiKey}`));
  } else {
    debug('Missing API key');
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
