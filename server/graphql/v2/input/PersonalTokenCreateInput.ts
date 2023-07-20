import { GraphQLInputObjectType, GraphQLList, GraphQLString } from 'graphql';

import { GraphQLOAuthScope } from '../enum/OAuthScope.js';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput.js';

export const GraphQLPersonalTokenCreateInput = new GraphQLInputObjectType({
  name: 'PersonalTokenCreateInput',
  description: 'Input type for PersonalToken',
  fields: () => ({
    name: { type: GraphQLString },
    scope: { type: new GraphQLList(GraphQLOAuthScope) },
    expiresAt: { type: GraphQLString },
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'The account to use as the owner of the application. Defaults to currently logged in user.',
    },
  }),
});
