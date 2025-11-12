import url from 'url';

import OAuth2Server, { AccessDeniedError, UnauthorizedRequestError } from '@node-oauth/oauth2-server';
import InvalidArgumentError from '@node-oauth/oauth2-server/lib/errors/invalid-argument-error';
import AuthorizeHandler from '@node-oauth/oauth2-server/lib/handlers/authorize-handler';
import TokenHandler from '@node-oauth/oauth2-server/lib/handlers/token-handler';
import BearerTokenType from '@node-oauth/oauth2-server/lib/token-types/bearer-token-type';
import { assign } from 'lodash';

import * as auth from '../../lib/auth';
import logger from '../logger';

import model from './model';

const Request = OAuth2Server.Request;
const Response = OAuth2Server.Response;

class CustomTokenHandler extends TokenHandler {
  constructor(...args) {
    super(...args);
  }

  getTokenType = function (model) {
    const accessToken = model.user.jwt(
      {
        scope: 'oauth',
        // eslint-disable-next-line camelcase
        access_token: model.accessToken,
      },
      auth.TOKEN_EXPIRATION_SESSION_OAUTH, // 90 days,
    );

    // Include refresh token in the response so clients can refresh access tokens
    return new BearerTokenType(
      accessToken,
      auth.TOKEN_EXPIRATION_SESSION_OAUTH,
      model.refreshToken || null,
      model.scope.join(' '),
    );
  };
}

class CustomAuthorizeHandler extends AuthorizeHandler {
  constructor(...args) {
    super(...args);
  }

  updateResponse = function (response, redirectUri, state) {
    redirectUri.query = redirectUri.query || {};

    if (state) {
      redirectUri.query.state = state;
    }

    // eslint-disable-next-line camelcase
    response.body = { redirect_uri: url.format(redirectUri) };
  };
}

class CustomOAuth2Server extends OAuth2Server {
  authorize = function (
    request: OAuth2Server.Request,
    response: OAuth2Server.Response,
    options?: OAuth2Server.AuthorizeOptions,
  ): Promise<OAuth2Server.AuthorizationCode> {
    options = assign(
      {
        allowEmptyState: false,
        authorizationCodeLifetime: 5 * 60, // 5 minutes. Update https://documentation.opencollective.com/development/oauth when changing this
      },
      this.options,
      options,
    );

    const authorizeHandler = <AuthorizeHandler>new CustomAuthorizeHandler(options);
    return authorizeHandler.handle(request, response);
  };

  // Library accepts a 4th parameter "callback", but it's not used there so we're omitting it
  token = function (request, response, options): Promise<OAuth2Server.Token> {
    options = assign(
      {
        accessTokenLifetime: auth.TOKEN_EXPIRATION_SESSION_OAUTH, // 90 days
        refreshTokenLifetime: 60 * 60 * 24 * 365, // 1 year
        allowExtendedTokenAttributes: false,
        requireClientAuthentication: {}, // defaults to true for all grant types
      },
      this.options,
      options,
    );

    const tokenHandler = <TokenHandler>new CustomTokenHandler(options);
    return tokenHandler.handle(request, response);
  };
}

// The following code is a copy of https://github.com/oauthjs/express-oauth-server */

function OAuthServer(options) {
  options = options || {};

  if (!options.model) {
    throw new InvalidArgumentError('Missing parameter: `model`');
  }

  this.useErrorHandler = options.useErrorHandler ? true : false;
  delete options.useErrorHandler;

  this.continueMiddleware = options.continueMiddleware ? true : false;
  delete options.continueMiddleware;

  this.server = new CustomOAuth2Server(options);
}

/**
 * Authentication Middleware.
 *
 * Returns a middleware that will validate a token.
 *
 * (See: https://tools.ietf.org/html/rfc6749#section-7)
 */

OAuthServer.prototype.authenticate = function (options) {
  return (req, res, next) => {
    const request = new Request(req);
    const response = new Response(res);
    return Promise.resolve()
      .then(() => {
        return this.server.authenticate(request, response, options);
      })
      .then(token => {
        res.locals.oauth = { token: token };
        next();
        return token;
      })
      .catch(e => {
        return handleError.call(this, e, req, res, null, next);
      });
  };
};

/**
 * Authorization Middleware.
 *
 * Returns a middleware that will authorize a client to request tokens.
 *
 * (See: https://tools.ietf.org/html/rfc6749#section-3.1)
 */

OAuthServer.prototype.authorize = function (options) {
  return (req, res, next) => {
    const request = new Request(req);
    const response = new Response(res);

    return Promise.resolve()
      .then(() => {
        return this.server.authorize(request, response, options);
      })
      .then(code => {
        res.locals.oauth = { code: code };
        if (this.continueMiddleware) {
          next();
        }
        return code;
      })
      .then(() => {
        return handleResponse.call(this, req, res, response);
      })
      .catch(e => {
        return handleError.call(this, e, req, res, response, next);
      });
  };
};

/**
 * Grant Middleware.
 *
 * Returns middleware that will grant tokens to valid requests.
 *
 * (See: https://tools.ietf.org/html/rfc6749#section-3.2)
 */

OAuthServer.prototype.token = function (options) {
  return (req, res, next) => {
    const request = new Request(req);
    const response = new Response(res);

    return Promise.resolve()
      .then(() => {
        return this.server.token(request, response, options);
      })
      .then(token => {
        res.locals.oauth = { token: token };
        if (this.continueMiddleware) {
          next();
        }
        return token;
      })
      .then(() => {
        return handleResponse.call(this, req, res, response);
      })
      .catch(e => {
        return handleError.call(this, e, req, res, response, next);
      });
  };
};

/**
 * Handle response.
 */
const handleResponse = function (req, res, response) {
  if (response.status === 302) {
    const location = response.headers.location;
    delete response.headers.location;
    res.set(response.headers);
    res.redirect(location);
  } else {
    res.set(response.headers);
    res.status(response.status).send(response.body);
  }
};

/**
 * Handle error.
 */

const handleError = function (e, req, res, response, next) {
  // https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2.1
  //
  // This implementation is both correct and technically incorrect, in theory
  // other error types should be redirected back, but untangling which error
  // types are safe to redirect on is a bit complicated due to the internals of
  // @node-oauth/oauth-server
  //
  // Theoretically we could always redirect unless the error is an instanceof
  // InvalidRequestError or InvalidClientError, but I'm not certain that these
  // are the only two error types that are non-redirectable.
  //
  // Therefore, we're only returning the redirect for the frontend if the error
  // is explicitly the AccessDeniedError (i.e., user clicked "cancel")
  if (e instanceof AccessDeniedError) {
    res.set(response.headers);
    res.status(response.status).send(response.body);
    return;
  }

  logger.error(e);
  if (this.useErrorHandler === true) {
    next(e);
  } else {
    if (response) {
      res.set(response.headers);
    }

    res.status(e.code);

    if (e instanceof UnauthorizedRequestError) {
      res.set(`WWW-Authenticate`, `Bearer realm="service"`);
      return res.send();
    }

    // eslint-disable-next-line camelcase
    res.send({ error: e.name, error_description: e.message });
  }
};

const oauth = new OAuthServer({
  model: model,
});

export const authorizeAuthenticateHandler = {
  handle: function (req) {
    if (!req.remoteUser) {
      throw new UnauthorizedRequestError('You must be signed in');
    }

    return req.remoteUser;
  },
};

export default oauth;
