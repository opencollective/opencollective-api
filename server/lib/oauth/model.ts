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

import activities from '../../constants/activities';
import models from '../../models';
import Application from '../../models/Application';
import type OAuthAuthorizationCode from '../../models/OAuthAuthorizationCode';
import User from '../../models/User';
import UserToken, { TokenType } from '../../models/UserToken';

const debug = debugLib('oAuth');

const TOKEN_LENGTH = 64;

interface OauthModel extends AuthorizationCodeModel, RefreshTokenModel {}

// Helpers to convert data from/to our model types to OAuth2Server types.

export const dbApplicationToClient = (application: Application): OAuth2Server.Client => ({
  id: application.clientId,
  redirectUris: [application.callbackUrl],
  // Allow exchanging authorization codes and refreshing access tokens
  grants: ['authorization_code', 'refresh_token'],
});

export const dbOAuthAuthorizationCodeToAuthorizationCode = (
  authorization: OAuthAuthorizationCode,
): AuthorizationCode => ({
  authorizationCode: authorization.code,
  expiresAt: authorization.expiresAt,
  redirectUri: authorization.redirectUri,
  codeChallenge: authorization.codeChallenge,
  codeChallengeMethod: authorization.codeChallengeMethod,
  client: dbApplicationToClient(authorization.application),
  user: authorization.user,
  scope: authorization.scope,
});

export const dbTokenToOAuthToken = async (token: any): Promise<Token> => {
  if (!token.user && token.UserId) {
    token.user = await models.User.findOne({ where: { id: token.UserId } });
  }
  if (!token.application && token.ApplicationId) {
    token.application = await models.Application.findOne({ where: { id: token.ApplicationId } });
  }
  if (!token.client && token.application) {
    token.client = dbApplicationToClient(token.application);
  }
  return token;
};

// For some reason `saveAuthorizationCode` and `saveToken` can receive a `scope`
// property that is a string[], string or undefined, and in the case of a string
// it may still be URL encoded. I wouldn't expected the framework to parse the
// scope value appropriately and just always give a `string[]` here, but
// apparently it does not.
//
// In order to handle both the previous accepted value of `read,write` and
// scope values that much the OAuth specification such as `read write` or
// when URL encoded `read%20write` we use the regex split.
//
// If there is no scope value (i.e., the application's scope's should apply),
// then we return an empty array, since OAuth Applications in OpenCollective
// cannot currently specify their valid scope values ahead of time.
function parseScopes(scope: string | string[] | undefined): string[] {
  if (Array.isArray(scope)) {
    return scope;
  } else if (typeof scope === 'string') {
    return decodeURIComponent(scope).split(/,|\s/);
  } else {
    return [];
  }
}

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

  async saveToken(token: OAuth2Server.Token, client: Client, user: User): Promise<Token> {
    debug('model.saveToken', token, client, user);
    try {
      const application = await models.Application.findOne({ where: { clientId: client.id } });
      const scope = parseScopes(token.scope);

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
        scope,
        preAuthorize2FA: Boolean(application.preAuthorize2FA),
      });
      return (await dbTokenToOAuthToken(oauthToken)) as Token;
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

    return (await dbTokenToOAuthToken(token)) as Token;
  },

  async getRefreshToken(refreshToken): Promise<RefreshToken> {
    debug('model.getRefreshToken', refreshToken);
    const token = await UserToken.findOne({ where: { refreshToken } });
    if (!token) {
      throw new InvalidTokenError('Invalid refresh token');
    }

    return (await dbTokenToOAuthToken(token)) as RefreshToken;
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

  async saveAuthorizationCode(code: AuthorizationCode, client: Client, user: User): Promise<AuthorizationCode> {
    debug('model.saveAuthorizationCode', code, client);
    const application = await models.Application.findOne({ where: { clientId: client.id } });
    const collective = await user.getCollective();
    const scope = parseScopes(code.scope);

    const authorization = await models.OAuthAuthorizationCode.create({
      ApplicationId: application.id,
      UserId: user.id,
      code: code.authorizationCode,
      expiresAt: code.expiresAt,
      redirectUri: code.redirectUri,
      scope,
      codeChallenge: code.codeChallenge ?? null,
      codeChallengeMethod: code.codeChallengeMethod ?? null,
    });

    // Only send the email if there is no active user token right now
    const userToken = await models.UserToken.findOne({
      where: { ApplicationId: application.id, UserId: user.id },
    });

    // Look if it's a new authorization, by default yes
    let newAuthorization = true;
    // Unless a token was already existing
    if (userToken) {
      // And there more scopes being asked than what there is in token scope
      newAuthorization =
        Array.from(scope || []).filter(x => !Array.from(userToken.scope || []).includes(x)).length !== 0;
    }

    if (newAuthorization) {
      await models.Activity.create({
        type: activities.OAUTH_APPLICATION_AUTHORIZED,
        UserId: user.id,
        CollectiveId: user.CollectiveId,
        data: {
          application: application.publicInfo,
          collective: collective.minimal,
          scope,
        },
      });
    }

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
    debug('model.verifyScope', token, scope);

    return true; // Scope verification is not implemented yet, but it's required by the library
  },

  // We're not validating scope at this point, because due to internal library implementation
  // that would disallow any connection attempt without scope
  /*
  async validateScope(user: User, client: Client, scope: string | string[]): Promise<string | string[]> {
    debug('model.validateScope', user, client, scope);

    return scope) // Scope validation is not implemented yet, and is not required by the library
  },
  */
};

export default model;
