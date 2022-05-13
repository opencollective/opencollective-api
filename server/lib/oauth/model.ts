/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-empty-function */

import crypto from 'crypto';

import config from 'config';
import jwt from 'jsonwebtoken';
import type OAuth2Server from 'oauth2-server';
import type {
  AuthorizationCode,
  AuthorizationCodeModel,
  ClientCredentialsModel,
  ExtensionModel,
  PasswordModel,
  RefreshTokenModel,
} from 'oauth2-server';

import * as auth from '../../lib/auth';
import models from '../../models';
import UserToken, { TokenType } from '../../models/UserToken';

const TOKEN_LENGTH = 64;

type OauthModel = AuthorizationCodeModel | ClientCredentialsModel | RefreshTokenModel | PasswordModel | ExtensionModel;

const model: OauthModel = {
  /** Invoked to generate a new access token */
  async generateAccessToken(client, user, scope) {
    console.log('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_' : 'test_oauth_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  async generateRefreshToken(client, user, scope) {
    console.log('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_refresh_' : 'test_oauth_refresh_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  async getAccessToken(accessToken: string): Promise<UserToken> {
    console.log('model.getAccessToken', accessToken);
    return UserToken.findOne({ where: { accessToken } });
  },

  async getRefreshToken(refreshToken) {
    console.log('model.getRefreshToken', refreshToken);
    return UserToken.findOne({ where: { refreshToken } });
  },

  async getAuthorizationCode(authorizationCode): Promise<AuthorizationCode> {
    console.log('model.getAuthorizationCode', authorizationCode);
    const jwt = auth.verifyJwt(authorizationCode);
    const client = await this.getClient(jwt.client || jwt.clientId || jwt.client_id, null);
    // No persistence for now, that might be a problem
    return {
      authorizationCode,
      client,
      user: await models.User.findByPk(jwt.sub),
      expiresAt: new Date(jwt.exp * 1000),
      redirectUri: client.callbackUrl,
    };
  },

  async generateAuthorizationCode(client, user, scope) {
    console.log('model.generateAuthorizationCode', client, user, scope);
    return jwt.sign({ clientId: client.id, scope: 'authorization_code' }, config.keys.opencollective.jwtSecret, {
      expiresIn: auth.TOKEN_EXPIRATION_LOGIN,
      subject: String(user.id),
      algorithm: auth.ALGORITHM,
      header: {
        kid: auth.KID,
      },
    });
  },

  async getClient(clientId, clientSecret) {
    console.log('model.getClient', clientId, clientSecret);
    const client = Number.isInteger(clientId)
      ? await models.Application.findByPk(clientId)
      : await models.Application.findOne({ where: { clientId } });
    return {
      ...client.dataValues,
      grants: ['authorization_code'],
      redirectUris: [client.callbackUrl],
    };
  },

  // TODO We shouldn't need this as we don't use password
  // getUser(username, password) {
  //   console.log('getUser', username, password);
  // },

  async getUserFromClient(client) {
    console.log('model.getUserFromClient', client);
  },

  async saveToken(token: OAuth2Server.Token, client: typeof models.Application, user: typeof models.User) {
    console.log('model.saveToken', token, client, user);
    try {
      // Delete existing Tokens as we have a 1 token only policy
      await UserToken.destroy({
        where: {
          ApplicationId: client.id,
          UserId: user.id,
        },
      });
      const oauthToken = await UserToken.create({
        type: TokenType.OAUTH,
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        refreshToken: token.refreshToken,
        refreshTokenExpiresAt: token.refreshTokenExpiresAt,
        ApplicationId: client.id,
        UserId: user.id,
      });
      oauthToken.user = user;
      oauthToken.client = client;
      return oauthToken;
    } catch (e) {
      console.log(e);
      // TODO: what should be thrown so it's properly catched on the library side?
      throw e;
    }
  },

  async saveAuthorizationCode(code, client) {
    console.log('model.saveAuthorizationCode', code, client);
    return code;
  },

  async revokeToken(token) {},

  async revokeAuthorizationCode(code) {
    // Code are used only once and revoked as soon as they're used
    return true;
  },

  // validateScope(user, client, scope) {}

  // verifyScope(accessToken, scope) {}
};

export default model;
