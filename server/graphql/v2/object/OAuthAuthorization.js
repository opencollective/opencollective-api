import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { Application } from '../object/Application';
import { Individual } from '../object/Individual';

export const OAuthAuthorization = new GraphQLObjectType({
  name: 'OAuthAuthorization',
  description: 'An OAuth authorization',
  fields: () => ({
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
