import Promise from 'bluebird';
import config from 'config';
import jwt from 'jsonwebtoken';
import { assign } from 'lodash';
import OAuth2Server from 'oauth2-server';
import InvalidArgumentError from 'oauth2-server/lib/errors/invalid-argument-error';
import UnauthorizedRequestError from 'oauth2-server/lib/errors/unauthorized-request-error';
import TokenHandler from 'oauth2-server/lib/handlers/token-handler';

import * as auth from '../../lib/auth';

import model from './model';

const Request = OAuth2Server.Request;
const Response = OAuth2Server.Response;

class CustomTokenHandler extends TokenHandler {
  getTokenType = function (model) {
    // console.log('CustomTokenHandler getTokenType', model);

    return {
      valueOf: () =>
        jwt.sign(
          {
            client_id: model.client.id,
            scope: 'oauth_access_token',
            access_token: model.accessToken,
            refresh_token: model.refreshToken,
          },
          config.keys.opencollective.jwtSecret,
          {
            expiresIn: auth.TOKEN_EXPIRATION_SESSION, // 90 days, LinkedIn = 60 days
            subject: String(model.user.id),
            algorithm: auth.ALGORITHM,
            header: {
              kid: auth.KID,
            },
          },
        ),
    };
  };
}

class CustomOAuth2Server extends OAuth2Server {
  token = function (request, response, options, callback) {
    options = assign(
      {
        accessTokenLifetime: 60 * 60, // 1 hour.
        refreshTokenLifetime: 60 * 60 * 24 * 14, // 2 weeks.
        allowExtendedTokenAttributes: false,
        requireClientAuthentication: {}, // defaults to true for all grant types
      },
      this.options,
      options,
    );
    return new CustomTokenHandler(options).handle(request, response).nodeify(callback);
  };
}

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
        console.log(e);
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
      return res.send();
    }

    res.send({ error: e.name, error_description: e.message });
  }
};

const oauth = new OAuthServer({
  model: model,
});

export const authorizeAuthenticateHandler = {
  handle: function (req) {
    if (req.remoteUser) {
      console.log('authorizeAuthenticateHandler with user');
    } else {
      console.log('authorizeAuthenticateHandler no user');
    }

    return req.remoteUser;
  },
};

export default oauth;
