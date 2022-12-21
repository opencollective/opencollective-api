import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { OAuthScope } from '../enum/OAuthScope';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { Individual } from './Individual';

export const PersonalToken = new GraphQLObjectType({
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
    },
    expiresAt: {
      type: GraphQLDateTime,
      description: 'The date on which the personal token expires',
    },
    scope: {
      type: new GraphQLList(OAuthScope),
      description: 'The scopes of the personal token',
    },
    account: {
      type: new GraphQLNonNull(Individual),
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
  }),
});
