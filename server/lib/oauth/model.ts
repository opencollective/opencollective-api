/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-empty-function */

import crypto from 'crypto';

import config from 'config';
import type OAuth2Server from 'oauth2-server';
import type {
  AuthorizationCode,
  AuthorizationCodeModel,
  Client,
  RefreshToken,
  RefreshTokenModel,
  Token,
} from 'oauth2-server';

import models from '../../models';
import type OAuthAuthorizationCode from '../../models/OAuthAuthorizationCode';
import UserToken, { TokenType } from '../../models/UserToken';

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
    console.log('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_' : 'test_oauth_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  async saveToken(token: OAuth2Server.Token, client: Client, user: typeof models.User): Promise<Token> {
    console.log('model.saveToken', token, client, user);
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
      return oauthToken;
    } catch (e) {
      console.log(e);
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
    // TODO: Remove these console.log before merging
    console.log('model.generateAccessToken', client, user, scope);
    const prefix = config.env === 'production' ? 'oauth_refresh_' : 'test_oauth_refresh_';
    return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
  },

  async getAccessToken(accessToken: string): Promise<Token> {
    console.log('model.getAccessToken', accessToken);
    return UserToken.findOne({ where: { accessToken } });
  },

  async getRefreshToken(refreshToken) {
    console.log('model.getRefreshToken', refreshToken);
    return UserToken.findOne({ where: { refreshToken } });
  },

  // -- Authorization code --
  async getAuthorizationCode(authorizationCode: string): Promise<AuthorizationCode> {
    console.log('model.getAuthorizationCode', authorizationCode);

    const authorization = await models.OAuthAuthorizationCode.findOne({
      where: { code: authorizationCode },
      include: [{ association: 'user' }, { association: 'application' }],
    });

    if (!authorization) {
      throw new Error('Invalid authorization code'); // TODO
    }

    return dbOAuthAuthorizationCodeToAuthorizationCode(authorization);
  },

  async saveAuthorizationCode(
    code: AuthorizationCode,
    client: Client,
    user: typeof models.User,
  ): Promise<AuthorizationCode> {
    console.log('model.saveAuthorizationCode', code, client);
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

  async getClient(clientId: string, clientSecret: string): Promise<Client> {
    console.log('model.getClient', clientId, clientSecret);
    const application = await models.Application.findOne({ where: { clientId } }); // TODO: Should we use clientSecret here?
    if (!application) {
      throw new Error('Invalid client'); // TODO
    }

    return dbApplicationToClient(application);
  },

  // -- Scope --

  async verifyScope(token: Token, scope: string | string[]): Promise<boolean> {
    return true; // Scope verification is not implemented yet, but it's required by the library
  },
};

export default model;
