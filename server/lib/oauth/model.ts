import crypto from 'crypto';

import config from 'config';
import type OAuthServer from 'express-oauth-server';
import models from '../../models';

type OAuthModel = OAuthServer.Options['model'];

const TOKEN_LENGTH = 64;

const model: OAuthModel = {
  /** Invoked to generate a new access token */
  generateAccessToken: async function (client, user, scope) {
    const prefix = config.env === 'production' ? 'oauth_' : 'test_oauth_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  generateRefreshToken: async function (client, user, scope) {
    const prefix = config.env === 'production' ? 'oauth_refresh_' : 'test_oauth_refresh_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  getAccessToken: async function (token) {
    return models.UserTokens.findOne({ where: { token: token } });
  },

  getRefreshToken: async function (refreshToken) {
    // TODO: Add index on `refreshToken`
    return models.UserTokens.findOne({ where: { refreshToken } });
  },

  getAuthorizationCode: function (authorizationCode) {},

  getClient: function (clientId, clientSecret) {},

  // TODO We shouldn't need this as we don't use password
  getUser: function (username, password) {},

  getUserFromClient: function (client) {},

  saveToken: function (token, client) {},

  saveAuthorizationCode: function (code, client) {},

  revokeToken: function (token) {},

  revokeAuthorizationCode: function (code) {},

  validateScope: function (user, client, scope) {},

  verifyScope: function (accessToken, scope) {},
};

export default model;
