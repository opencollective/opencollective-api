/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-empty-function */

import crypto from 'crypto';

import config from 'config';
import type OAuth2Server from 'oauth2-server';
import type {
  AuthorizationCodeModel,
  ClientCredentialsModel,
  ExtensionModel,
  PasswordModel,
  RefreshTokenModel,
} from 'oauth2-server';

import models from '../../models';
import UserToken, { TokenType } from '../../models/UserToken';

const TOKEN_LENGTH = 64;

export default class OAuthModel
  implements AuthorizationCodeModel, ClientCredentialsModel, RefreshTokenModel, PasswordModel, ExtensionModel
{
  /** Invoked to generate a new access token */
  async generateAccessToken(client, user, scope) {
    console.log('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_' : 'test_oauth_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  }

  async generateRefreshToken(client, user, scope) {
    console.log('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_refresh_' : 'test_oauth_refresh_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  }

  async getAccessToken(accessToken: string): Promise<UserToken> {
    console.log('model.getAccessToken', accessToken);
    return UserToken.findOne({ where: { accessToken } });
  }

  async getRefreshToken(refreshToken) {
    console.log('model.getRefreshToken', refreshToken);
    return UserToken.findOne({ where: { refreshToken } });
  }

  async getAuthorizationCode(authorizationCode) {
    console.log('model.getAuthorizationCode', authorizationCode);
    // No persistence for now, that might be a problem
    return {
      authorizationCode,
    };
  }

  // generateAuthorizationCode(client, user, scope) {
  //   console.log('model.generateAuthorizationCode', client, user, scope);
  // },

  async getClient(clientId, clientSecret) {
    console.log('model.getClient', clientId, clientSecret);
    const client = await models.Application.findOne({ where: { clientId } });
    return { ...client, grants: ['authorization_code'], redirectUris: [client.callbackUrl] };
  }

  // TODO We shouldn't need this as we don't use password
  // getUser(username, password) {
  //   console.log('getUser', username, password);
  // },

  async getUserFromClient(client) {
    console.log('model.getUserFromClient', client);
  }

  async saveToken(token: OAuth2Server.Token, client: typeof models.Application) {
    console.log('model.saveToken', token, client);
    return UserToken.create({
      type: TokenType.OAUTH,
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshToken: token.refreshToken,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
      ApplicationId: client.id,
      UserId: token.user.id,
    });
  }

  async saveAuthorizationCode(code, client) {
    console.log('model.saveAuthorizationCode', code, client);
    return code;
  }

  async revokeToken(token) {}

  async revokeAuthorizationCode(code) {}

  // validateScope(user, client, scope) {}

  // verifyScope(accessToken, scope) {}
}
