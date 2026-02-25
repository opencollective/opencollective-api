import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import FEATURE from '../../../constants/feature';
import { hasFeature } from '../../../lib/allowed-features';
import { canUseFeature } from '../../../lib/user-permissions';
import { Collective } from '../../../models';
import { checkScope } from '../../common/scope-check';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLPermission, PermissionFields } from './Permission';

const GraphQLAccountPermissions = new GraphQLObjectType({
  name: 'AccountPermissions',
  description: 'Fields for the user permissions on an account',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      deprecationReason: '2026-02-25: use publicId',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACCOUNT),
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${Collective.nanoIdPrefix}_xxxxxxxx)`,
    },
    addFunds: {
      type: new GraphQLNonNull(GraphQLPermission),
      description: 'Whether the current user can add funds to this account',
      resolve(collective, _, req: express.Request): PermissionFields {
        return { allowed: (checkScope(req, 'host') && req.remoteUser?.isAdmin(collective.HostCollectiveId)) || false };
      },
    },
    contact: {
      type: new GraphQLNonNull(GraphQLPermission),
      description: 'Whether the current user can contact this account',
      resolve(collective, _, req: express.Request): PermissionFields {
        if (!canUseFeature(req.remoteUser, FEATURE.CONTACT_COLLECTIVE)) {
          return { allowed: false, reason: 'You are not authorized to contact other accounts' };
        } else {
          return { allowed: hasFeature(collective, FEATURE.CONTACT_FORM, { loaders: req.loaders }) };
        }
      },
    },
    canDownloadPaymentReceipts: {
      type: new GraphQLNonNull(GraphQLPermission),
      description: "Whether the current user can download this account's payment receipts",
      resolve(collective, _, req: express.Request): PermissionFields {
        return {
          allowed: Boolean(req.remoteUser?.hasRoleInCollectiveOrHost(['ADMIN', 'ACCOUNTANT'], collective)),
        };
      },
    },
  }),
});

export default GraphQLAccountPermissions;
