import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

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
    },
    type: {
      type: GraphQLPayoutMethodType,
      description: 'The type of this payout method (usually the payment provider)',
    },
    name: {
      type: GraphQLString,
      description: 'A friendly name for users to easily find their payout methods',
      resolve: async (payoutMethod, _, req: express.Request): Promise<string> => {
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
      resolve: async (payoutMethod, _, req: express.Request): Promise<Record<string, unknown>> => {
        const collective = await req.loaders.Collective.byId.load(payoutMethod.CollectiveId);
        if (
          req.remoteUser?.isAdminOfCollective(collective) ||
          getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id)
        ) {
          if (checkScope(req, 'expenses')) {
            return payoutMethod.data;
          }
        }
      },
    },
  }),
});

export default GraphQLPayoutMethod;
