import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import { TWO_FACTOR_SESSIONS_PARAMS } from '../../../lib/two-factor-authentication/lib';
import { GraphQLOAuthScope } from '../enum/OAuthScope';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLIndividual } from './Individual';

export const GraphQLPersonalToken = new GraphQLObjectType({
  name: 'PersonalToken',
  description: 'A personal token',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.PERSONAL_TOKEN),
      description: 'Unique identifier for this personal token',
    },
    name: {
      type: GraphQLString,
      description: 'A friendly name for users to easily find their personal tokens',
    },
    token: {
      type: GraphQLString,
      description: 'The personal token',
      resolve: async (personalToken, _, req): Promise<string> => {
        const collective = await req.loaders.Collective.byId.load(personalToken.CollectiveId);
        await twoFactorAuthLib.enforceForAccount(req, collective, TWO_FACTOR_SESSIONS_PARAMS.MANAGE_PERSONAL_TOKENS);
        return personalToken.token;
      },
    },
    expiresAt: {
      type: GraphQLDateTime,
      description: 'The date on which the personal token expires',
    },
    scope: {
      type: new GraphQLList(GraphQLOAuthScope),
      description: 'The scopes of the personal token',
    },
    account: {
      type: new GraphQLNonNull(GraphQLIndividual),
      description: 'The account that owns this personal token',
      resolve: async (personalToken, _, req): Promise<Record<string, unknown>> => {
        return req.loaders.Collective.byId.load(personalToken.CollectiveId);
      },
    },
    createdAt: {
      type: GraphQLDateTime,
      description: 'The date on which the personal token was created',
    },
    updatedAt: {
      type: GraphQLDateTime,
      description: 'The date on which the personal token was last updated',
    },
    preAuthorize2FA: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether this token is allowed to directly use operations that would normally require 2FA',
    },
  }),
});
