import { GraphQLInputObjectType, GraphQLList, GraphQLString } from 'graphql';

import { GraphQLOAuthScope } from '../enum/OAuthScope';

import { PersonalTokenReferenceFields } from './PersonalTokenReferenceInput';

export const GraphQLPersonalTokenUpdateInput = new GraphQLInputObjectType({
  name: 'PersonalTokenUpdateInput',
  description: 'Input type for PersonalToken',
  fields: () => ({
    ...PersonalTokenReferenceFields,
    name: { type: GraphQLString },
    scope: { type: new GraphQLList(GraphQLOAuthScope) },
    expiresAt: { type: GraphQLString },
  }),
});
