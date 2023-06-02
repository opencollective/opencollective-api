import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { checkScope } from '../../common/scope-check';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLPermission, PermissionFields } from './Permission';

const GraphQLAccountPermissions = new GraphQLObjectType({
  name: 'AccountPermissions',
  description: 'Fields for the user permissions on an account',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACCOUNT),
    },
    addFunds: {
      type: new GraphQLNonNull(GraphQLPermission),
      description: 'Whether the current user can mark this order as expired',
      resolve(collective, _, req: express.Request): PermissionFields {
        return { allowed: (checkScope(req, 'host') && req.remoteUser?.isAdmin(collective.HostCollectiveId)) || false };
      },
    },
  }),
});

export default GraphQLAccountPermissions;
