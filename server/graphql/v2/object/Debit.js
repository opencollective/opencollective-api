import { GraphQLObjectType } from 'graphql';

import { Account } from '../interface/Account';
import { Transaction, TransactionFields } from '../interface/Transaction';

export const Debit = new GraphQLObjectType({
  name: 'Debit',
  description: 'This represents a Debit transaction',
  interfaces: () => [Transaction],
  isTypeOf: transaction => transaction.type === 'DEBIT',
  fields: () => {
    return {
      ...TransactionFields(),
      fromAccount: {
        type: Account,
        resolve(transaction, _, req) {
          return req.loaders.Collective.byId.load(transaction.CollectiveId);
        },
      },
      toAccount: {
        type: Account,
        resolve(transaction, _, req) {
          return req.loaders.Collective.byId.load(transaction.FromCollectiveId);
        },
      },
    };
  },
});
