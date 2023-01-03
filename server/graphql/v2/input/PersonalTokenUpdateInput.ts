import { GraphQLInputObjectType, GraphQLList, GraphQLString } from 'graphql';

import { OAuthScope } from '../enum/OAuthScope';

import { PersonalTokenReferenceFields } from './PersonalTokenReferenceInput';

export const PersonalTokenUpdateInput = new GraphQLInputObjectType({
  name: 'PersonalTokenUpdateInput',
  description: 'Input type for PersonalToken',
  fields: () => ({
    ...PersonalTokenReferenceFields,
    name: { type: GraphQLString },
    scope: { type: new GraphQLList(OAuthScope) },
    expiresAt: { type: GraphQLString },
  }),
});
