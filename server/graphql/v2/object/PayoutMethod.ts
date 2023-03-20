import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkScope } from '../../common/scope-check';
import { PayoutMethodType } from '../enum/PayoutMethodType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

const PayoutMethod = new GraphQLObjectType({
  name: 'PayoutMethod',
  description: 'A payout method',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.PAYOUT_METHOD),
      description: 'Unique identifier for this payout method',
    },
    type: {
      type: PayoutMethodType,
      description: 'The type of this payout method (usually the payment provider)',
    },
    name: {
      type: GraphQLString,
      description: 'A friendly name for users to easily find their payout methods',
      resolve: (payoutMethod, _, req: express.Request): string => {
        if (
          req.remoteUser?.isAdmin(payoutMethod.CollectiveId) ||
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
      resolve: (payoutMethod, _, req: express.Request): boolean => {
        if (
          req.remoteUser?.isAdmin(payoutMethod.CollectiveId) ||
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
      resolve: (payoutMethod, _, req: express.Request): Record<string, unknown> => {
        if (
          req.remoteUser?.isAdmin(payoutMethod.CollectiveId) ||
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

export default PayoutMethod;
