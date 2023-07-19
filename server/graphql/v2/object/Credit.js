import { GraphQLObjectType } from 'graphql';

import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions.js';
import { GraphQLAccount } from '../interface/Account.js';
import { GraphQLTransaction, TransactionFields } from '../interface/Transaction.js';

export const GraphQLCredit = new GraphQLObjectType({
  name: 'Credit',
  description: 'This represents a Credit transaction',
  interfaces: () => [GraphQLTransaction],
  isTypeOf: transaction => transaction.type === 'CREDIT',
  fields: () => {
    return {
      ...TransactionFields(),
      fromAccount: {
        type: GraphQLAccount,
        resolve(transaction, _, req) {
          if (transaction.FromCollectiveId) {
            if (req.remoteUser?.isAdmin(transaction.HostCollectiveId)) {
              allowContextPermission(
                req,
                PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO,
                transaction.FromCollectiveId,
              );
            }

            return req.loaders.Collective.byId.load(transaction.FromCollectiveId);
          }
        },
      },
      toAccount: {
        type: GraphQLAccount,
        resolve(transaction, _, req) {
          if (transaction.CollectiveId) {
            return req.loaders.Collective.byId.load(transaction.CollectiveId);
          }
        },
      },
    };
  },
});
