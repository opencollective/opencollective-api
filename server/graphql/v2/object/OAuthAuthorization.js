import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import models from '../../../models';
import { GraphQLOAuthScope } from '../enum/OAuthScope';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLApplication } from '../object/Application';
import { GraphQLIndividual } from '../object/Individual';

export const GraphQLOAuthAuthorization = new GraphQLObjectType({
  name: 'OAuthAuthorization',
  description: 'An OAuth authorization',
  fields: () => ({
    id: {
      type: GraphQLString,
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.USER_TOKEN),
    },
    account: {
      type: new GraphQLNonNull(GraphQLIndividual),
      resolve(authorization) {
        return authorization.account;
      },
    },
    application: {
      type: new GraphQLNonNull(GraphQLApplication),
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
              UserId: authorization.user.id,
              UserTokenId: authorization.id,
            },
            order: [['createdAt', 'DESC']],
          });
          return activity?.createdAt ?? null;
        }
      },
    },
    scope: {
      type: new GraphQLList(GraphQLOAuthScope),
      description: 'The attached scopes.',
    },
    preAuthorize2FA: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether this OAuth token is allowed to directly use operations that would normally require 2FA',
    },
  }),
});
