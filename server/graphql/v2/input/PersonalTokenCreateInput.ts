import { GraphQLBoolean, GraphQLInputObjectType, GraphQLList, GraphQLString } from 'graphql';

import { GraphQLOAuthScope } from '../enum/OAuthScope';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLPersonalTokenCreateInput = new GraphQLInputObjectType({
  name: 'PersonalTokenCreateInput',
  description: 'Input type for PersonalToken',
  fields: () => ({
    name: { type: GraphQLString },
    scope: { type: new GraphQLList(GraphQLOAuthScope) },
    expiresAt: { type: GraphQLString },
    preAuthorize2FA: {
      type: GraphQLBoolean,
      defaultValue: false,
      description: 'Whether this token is allowed to directly use operations that would normally require 2FA',
    },
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'The account to use as the owner of the application. Defaults to currently logged in user.',
    },
  }),
});
