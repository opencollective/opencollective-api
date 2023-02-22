import { GraphQLObjectType } from 'graphql';

import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLTransaction, TransactionFields } from '../interface/Transaction';

export const GraphQLDebit = new GraphQLObjectType({
  name: 'Debit',
  description: 'This represents a Debit transaction',
  interfaces: () => [GraphQLTransaction],
  isTypeOf: transaction => transaction.type === 'DEBIT',
  fields: () => {
    return {
      ...TransactionFields(),
      fromAccount: {
        type: GraphQLAccount,
        resolve(transaction, _, req) {
          if (transaction.CollectiveId) {
            if (req.remoteUser?.isAdmin(transaction.HostCollectiveId)) {
              allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, transaction.CollectiveId);
            }

            return req.loaders.Collective.byId.load(transaction.CollectiveId);
          }
        },
      },
      toAccount: {
        type: GraphQLAccount,
        resolve(transaction, _, req) {
          if (transaction.FromCollectiveId) {
            return req.loaders.Collective.byId.load(transaction.FromCollectiveId);
          }
        },
      },
    };
  },
});
