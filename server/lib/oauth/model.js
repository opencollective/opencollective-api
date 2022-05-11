const model = {
  generateAccessToken: function (client, user, scope) {},

  generateRefreshToken: function (client, user, scope) {},

  getAccessToken: function (accessToken) {},

  getRefreshToken: function (refreshToken) {},

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
