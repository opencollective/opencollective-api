import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Application } from '../object/Application';
import { Individual } from '../object/Individual';

export const OauthAuthorization = new GraphQLObjectType({
  name: 'OauthAuthorization',
  description: 'An OAuth authorization',
  fields: () => ({
    id: {
      type: GraphQLString,
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.USER_TOKEN),
    },
    account: {
      type: new GraphQLNonNull(Individual),
      resolve(authorization) {
        return authorization.account;
      },
    },
    application: {
      type: new GraphQLNonNull(Application),
      resolve(authorization) {
        return authorization.application;
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The time of creation',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The time of last update',
    },
    expiresAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The time of expiration',
    },
  }),
});
