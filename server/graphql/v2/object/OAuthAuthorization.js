import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import models from '../../../models';
import { OAuthScope } from '../enum/OAuthScope';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Application } from '../object/Application';
import { Individual } from '../object/Individual';

export const OAuthAuthorization = new GraphQLObjectType({
  name: 'OAuthAuthorization',
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
    lastUsedAt: {
      type: GraphQLDateTime,
      description: 'The last time of token was used',
      async resolve(authorization, _, req) {
        if (req.remoteUser?.isAdmin(authorization.account.id)) {
          const activity = await models.Activity.findOne({
            attributes: ['createdAt'],
            where: {
              UserTokenId: authorization.id,
            },
            order: [['createdAt', 'DESC']],
          });
          return activity?.createdAt ?? null;
        }
      },
    },
    scope: {
      type: new GraphQLList(OAuthScope),
      description: 'The attached scopes.',
    },
  }),
});
