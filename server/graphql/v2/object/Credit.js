import { GraphQLObjectType } from 'graphql';

import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { Account } from '../interface/Account';
import { Transaction, TransactionFields } from '../interface/Transaction';

export const Credit = new GraphQLObjectType({
  name: 'Credit',
  description: 'This represents a Credit transaction',
  interfaces: () => [Transaction],
  isTypeOf: transaction => transaction.type === 'CREDIT',
  fields: () => {
    return {
      ...TransactionFields(),
      fromAccount: {
        type: Account,
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
        type: Account,
        resolve(transaction, _, req) {
          if (transaction.CollectiveId) {
            return req.loaders.Collective.byId.load(transaction.CollectiveId);
          }
        },
      },
    };
  },
});
