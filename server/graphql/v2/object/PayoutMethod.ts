import { GraphQLString, GraphQLObjectType, GraphQLNonNull, GraphQLBoolean } from 'graphql';
import GraphQLJSON from 'graphql-type-json';

import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import PayoutMethodType from '../enum/PayoutMethodType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

const PayoutMethod = new GraphQLObjectType({
  name: 'PayoutMethod',
  description: 'A payout method',
  fields: {
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
      resolve: (payoutMethod, _, req): string => {
        // Only collective admins can see the name of a payout method
        if (req.remoteUser?.isAdmin(payoutMethod.CollectiveId)) {
          return payoutMethod.isSaved;
        }
      },
    },
    isSaved: {
      type: GraphQLBoolean,
      description: 'Whether this payout method has been saved to be used for future payouts',
      resolve: (payoutMethod, _, req): boolean => {
        // Only collective admins can see whether a payout method is saved or not
        if (req.remoteUser?.isAdmin(payoutMethod.CollectiveId)) {
          return payoutMethod.isSaved;
        }
      },
    },
    data: {
      type: GraphQLJSON,
      description: 'The actual data for this payout method. Content depends on the type.',
      resolve: (payoutMethod, _, req): object => {
        if (
          req.remoteUser?.isAdmin(payoutMethod.CollectiveId) ||
          getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, payoutMethod.id)
        ) {
          return payoutMethod.data;
        }
      },
    },
  },
});

export default PayoutMethod;
