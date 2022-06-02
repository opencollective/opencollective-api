/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-empty-function */

import crypto from 'crypto';

import type OAuth2Server from '@node-oauth/oauth2-server';
import {
  AuthorizationCode,
  AuthorizationCodeModel,
  Client,
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  RefreshToken,
  RefreshTokenModel,
  Token,
} from '@node-oauth/oauth2-server';
import config from 'config';
import debugLib from 'debug';

import models from '../../models';
import type OAuthAuthorizationCode from '../../models/OAuthAuthorizationCode';
import UserToken, { TokenType } from '../../models/UserToken';

const debug = debugLib('oAuth');

const TOKEN_LENGTH = 64;

interface OauthModel extends AuthorizationCodeModel, RefreshTokenModel {}

// Helpers to convert data from/to our model types to OAuth2Server types.

export const dbApplicationToClient = (application: typeof models.Application): OAuth2Server.Client => ({
  id: application.clientId,
  redirectUris: [application.callbackUrl],
  grants: ['authorization_code'],
});

export const dbOAuthAuthorizationCodeToAuthorizationCode = (
  authorization: OAuthAuthorizationCode,
): AuthorizationCode => ({
  authorizationCode: authorization.code,
  expiresAt: authorization.expiresAt,
  redirectUri: authorization.redirectUri,
  client: dbApplicationToClient(authorization.application),
  user: authorization.user,
});

/**
 * OAuth model implementation.
 */
const model: OauthModel = {
  // -- Access token --
  /** Invoked to generate a new access token */
  async generateAccessToken(client: Client, user, scope): Promise<string> {
    debug('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_' : 'test_oauth_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  async saveToken(token: OAuth2Server.Token, client: Client, user: typeof models.User): Promise<Token> {
    debug('model.saveToken', token, client, user);
    try {
      const application = await models.Application.findOne({ where: { clientId: client.id } });

      // Delete existing Tokens as we have a 1 token only policy
      await UserToken.destroy({
        where: {
          ApplicationId: application.id,
          UserId: user.id,
        },
      });

      const oauthToken = await UserToken.create({
        type: TokenType.OAUTH,
        accessToken: token.accessToken,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        refreshToken: token.refreshToken,
        refreshTokenExpiresAt: token.refreshTokenExpiresAt,
        ApplicationId: application.id,
        UserId: user.id,
      });
      oauthToken.user = user;
      oauthToken.client = client;
      return <Token>oauthToken;
    } catch (e) {
      debug(e);
      // TODO: what should be thrown so it's properly catched on the library side?
      throw e;
    }
  },

  async revokeToken(token: RefreshToken | Token): Promise<boolean> {
    const nbDeleted = await models.UserToken.destroy({ where: { refreshToken: token.refreshToken } });
    return nbDeleted > 0;
  },

  // -- Refresh token --
  async generateRefreshToken(client, user, scope) {
    debug('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_refresh_' : 'test_oauth_refresh_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  async getAccessToken(accessToken: string): Promise<Token> {
    debug('model.getAccessToken', accessToken);
    const token = await UserToken.findOne({ where: { accessToken } });
    if (!token) {
      throw new InvalidTokenError('Invalid token');
    }

    return <Token>token;
  },

  async getRefreshToken(refreshToken): Promise<RefreshToken> {
    debug('model.getRefreshToken', refreshToken);
    const token = await UserToken.findOne({ where: { refreshToken } });
    if (!token) {
      throw new InvalidTokenError('Invalid refresh token');
    }

    return <RefreshToken>token;
  },

  // -- Authorization code --
  async getAuthorizationCode(authorizationCode: string): Promise<AuthorizationCode> {
    debug('model.getAuthorizationCode', authorizationCode);
    const authorization = await models.OAuthAuthorizationCode.findOne({
      where: { code: authorizationCode },
      include: [{ association: 'user' }, { association: 'application' }],
    });

    if (!authorization) {
      throw new InvalidGrantError('Invalid authorization code');
    }

    return dbOAuthAuthorizationCodeToAuthorizationCode(authorization);
  },

  async saveAuthorizationCode(
    code: AuthorizationCode,
    client: Client,
    user: typeof models.User,
  ): Promise<AuthorizationCode> {
    debug('model.saveAuthorizationCode', code, client);
    const application = await models.Application.findOne({ where: { clientId: client.id } });
    const authorization = await models.OAuthAuthorizationCode.create({
      ApplicationId: application.id,
      UserId: user.id,
      code: code.authorizationCode,
      expiresAt: code.expiresAt,
      redirectUri: code.redirectUri,
    });

    authorization.application = application;
    authorization.user = user;
    return dbOAuthAuthorizationCodeToAuthorizationCode(authorization);
  },

  async revokeAuthorizationCode({ authorizationCode }: AuthorizationCode): Promise<boolean> {
    const nbDeleted = await models.OAuthAuthorizationCode.destroy({ where: { code: authorizationCode } });
    return nbDeleted > 0;
  },

  // -- Client --

  async getClient(clientId: string, clientSecret: string | null): Promise<Client> {
    debug('model.getClient', clientId, clientSecret);
    const application = await models.Application.findOne({ where: { clientId } });
    if (!application) {
      throw new InvalidClientError('Invalid client');
    } else if (clientSecret && application.clientSecret !== clientSecret) {
      throw new InvalidClientError('Invalid client credentials');
    }

    return dbApplicationToClient(application);
  },

  // -- Scope --

  async verifyScope(token: Token, scope: string | string[]): Promise<boolean> {
    return true; // Scope verification is not implemented yet, but it's required by the library
  },
};

export default model;
