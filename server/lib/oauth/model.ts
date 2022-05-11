import type OAuthServer from 'express-oauth-server';

type OAuthModel = OAuthServer.Options['model'];

const model: OAuthModel = {
  generateAccessToken: async function (client, user, scope) {
    return 'TODO';
  },

  generateRefreshToken: async function (client, user, scope) {
    return 'TODO';
  },

  getAccessToken: async function (accessToken) {},

  getRefreshToken: async function (refreshToken) {},

  getAuthorizationCode: function (authorizationCode) {},

  getClient: function (clientId, clientSecret) {},

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
