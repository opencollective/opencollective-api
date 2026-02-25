import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { PayoutMethod } from '../../../models';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkScope } from '../../common/scope-check';
import { GraphQLPayoutMethodType } from '../enum/PayoutMethodType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

const GraphQLPayoutMethod = new GraphQLObjectType({
  name: 'PayoutMethod',
  description: 'A payout method',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.PAYOUT_METHOD),
      description: 'Unique identifier for this payout method',
      deprecationReason: '2026-02-25: use publicId',
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${PayoutMethod.nanoIdPrefix}_xxxxxxxx)`,
    },
    type: {
      type: GraphQLPayoutMethodType,
      description: 'The type of this payout method (usually the payment provider)',
    },
    name: {
      type: GraphQLString,
      description: 'A friendly name for users to easily find their payout methods',
      resolve: async (payoutMethod, _, req: express.Request): Promise<string | null> => {
        const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
        if (
          req.remoteUser?.isAdminOfCollective(collective) ||
          getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id)
        ) {
          if (checkScope(req, 'expenses')) {
            return payoutMethod.name;
          }
        }
      },
    },
    isSaved: {
      type: GraphQLBoolean,
      description: 'Whether this payout method has been saved to be used for future payouts',
      resolve: async (payoutMethod, _, req: express.Request): Promise<boolean> => {
        const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
        if (
          req.remoteUser?.isAdminOfCollective(collective) ||
          getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id)
        ) {
          if (checkScope(req, 'expenses')) {
            return payoutMethod.isSaved;
          }
        }
      },
    },
    data: {
      type: GraphQLJSON,
      description: 'The actual data for this payout method. Content depends on the type.',
      resolve: async (payoutMethod, _, req: express.Request): Promise<Record<string, unknown> | null> => {
        const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
        if (
          (req.remoteUser?.isAdminOfCollective(collective) && payoutMethod.isSaved) ||
          getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id)
        ) {
          if (checkScope(req, 'expenses')) {
            return payoutMethod.data;
          }
        }
      },
    },
    canBeEdited: {
      type: GraphQLBoolean,
      description: 'Whether this payout method can be edited',
      resolve: async (payoutMethod: PayoutMethod, _, req: express.Request): Promise<boolean> => {
        if (!req.remoteUser) {
          return false;
        }
        const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
        if (req.remoteUser?.isAdminOfCollective(collective)) {
          return (await payoutMethod.canBeEdited()) || (await payoutMethod.canBeArchived());
        } else {
          return false;
        }
      },
    },
    canBeDeleted: {
      type: GraphQLBoolean,
      description: 'Whether this payout method can be deleted or only archived',
      resolve: async (payoutMethod: PayoutMethod, _, req: express.Request): Promise<boolean> => {
        if (!req.remoteUser) {
          return false;
        }
        const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
        if (req.remoteUser?.isAdminOfCollective(collective)) {
          return payoutMethod.canBeDeleted();
        } else {
          return false;
        }
      },
    },
    canBeArchived: {
      type: GraphQLBoolean,
      description: 'Whether this payout method can be archived',
      resolve: async (payoutMethod: PayoutMethod, _, req: express.Request): Promise<boolean> => {
        if (!req.remoteUser) {
          return false;
        }
        const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
        if (req.remoteUser?.isAdminOfCollective(collective)) {
          return payoutMethod.canBeArchived();
        } else {
          return false;
        }
      },
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date and time this payout method was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date and time this payout method was updated',
    },
  }),
});

export default GraphQLPayoutMethod;
