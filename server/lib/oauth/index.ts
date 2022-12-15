import url from 'url';

import OAuth2Server, { UnauthorizedRequestError } from '@node-oauth/oauth2-server';
import InvalidArgumentError from '@node-oauth/oauth2-server/lib/errors/invalid-argument-error';
import AuthorizeHandler from '@node-oauth/oauth2-server/lib/handlers/authorize-handler';
import TokenHandler from '@node-oauth/oauth2-server/lib/handlers/token-handler';
import Promise from 'bluebird';
import config from 'config';
import jwt from 'jsonwebtoken';
import { assign } from 'lodash';

import * as auth from '../../lib/auth';

import model from './model';

const Request = OAuth2Server.Request;
const Response = OAuth2Server.Response;

class CustomTokenHandler extends TokenHandler {
  constructor(...args) {
    super(...args);
  }

  getTokenType = function (model) {
    return {
      valueOf: () => {
        const accessToken = jwt.sign(
          {
            // eslint-disable-next-line camelcase
            access_token: model.accessToken,
          },
          config.keys.opencollective.jwtSecret,
          {
            expiresIn: auth.TOKEN_EXPIRATION_SESSION, // 90 days
            subject: String(model.user.id),
            algorithm: auth.ALGORITHM,
            header: {
              kid: auth.KID,
            },
          },
        );
        // eslint-disable-next-line camelcase
        return { access_token: accessToken };
      },
    };
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
        authorizationCodeLifetime: 5 * 60, // 5 minutes. Update https://docs.opencollective.com/help/developers/oauth#users-are-redirected-back-to-your-site when changing this
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
        accessTokenLifetime: auth.TOKEN_EXPIRATION_SESSION, // 1 hour.
        refreshTokenLifetime: 60 * 60 * 24 * 365, // 2 weeks.
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
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const that = this; //

  return function (req, res, next) {
    const request = new Request(req);
    const response = new Response(res);
    return Promise.bind(that)
      .then(function () {
        return this.server.authenticate(request, response, options);
      })
      .tap(token => {
        res.locals.oauth = { token: token };
        next();
      })
      .catch(function (e) {
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
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const that = this;

  return function (req, res, next) {
    const request = new Request(req);
    const response = new Response(res);

    return Promise.bind(that)
      .then(function () {
        return this.server.authorize(request, response, options);
      })
      .tap(function (code) {
        res.locals.oauth = { code: code };
        if (this.continueMiddleware) {
          next();
        }
      })
      .then(function () {
        return handleResponse.call(this, req, res, response);
      })
      .catch(function (e) {
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
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const that = this;

  return function (req, res, next) {
    const request = new Request(req);
    const response = new Response(res);

    return Promise.bind(that)
      .then(function () {
        return this.server.token(request, response, options);
      })
      .tap(function (token) {
        res.locals.oauth = { token: token };
        if (this.continueMiddleware) {
          next();
        }
      })
      .then(function () {
        return handleResponse.call(this, req, res, response);
      })
      .catch(function (e) {
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
