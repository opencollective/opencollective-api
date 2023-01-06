import { GraphQLInputObjectType, GraphQLList, GraphQLString } from 'graphql';

import { OAuthScope } from '../enum/OAuthScope';

import { AccountReferenceInput } from './AccountReferenceInput';

export const PersonalTokenCreateInput = new GraphQLInputObjectType({
  name: 'PersonalTokenCreateInput',
  description: 'Input type for PersonalToken',
  fields: () => ({
    name: { type: GraphQLString },
    scope: { type: new GraphQLList(OAuthScope) },
    expiresAt: { type: GraphQLString },
    account: {
      type: AccountReferenceInput,
      description: 'The account to use as the owner of the application. Defaults to currently logged in user.',
    },
  }),
});
