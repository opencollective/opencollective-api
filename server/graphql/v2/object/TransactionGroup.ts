import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { sequelize, Transaction } from '../../../models';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLTransaction } from '../interface/Transaction';
import { GraphQLAmount } from '../object/Amount';
import { getTransactionKindPriorityCase } from '../query/collection/TransactionsCollectionQuery';

export const GraphQLTransactionGroup = new GraphQLObjectType({
  name: 'TransactionGroup',
  description: 'Transaction group',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
      amount: {
        type: new GraphQLNonNull(GraphQLAmount),
      },
      host: {
        type: GraphQLAccount,
      },
      account: {
        type: GraphQLAccount,
        description: 'The account on the main side of the transaction (CREDIT -> recipient, DEBIT -> sender)',
      },
      primaryTransaction: {
        type: GraphQLTransaction,
        description: 'The primary transaction in the group',
        resolve: async (transactionGroup, _, req) => {
          return req.loaders.Transaction.byId.load(transactionGroup.primaryTransactionId);
        },
      },
      transactions: {
        type: new GraphQLList(GraphQLTransaction),
        description: 'The transactions in the group',
        resolve: async transactionGroup => {
          // If transactions are already loaded (when used with the TransactionGroupQuery), return directly
          if (transactionGroup.transactions) {
            return transactionGroup.transactions;
          }
          return await Transaction.findAll({
            where: { TransactionGroup: transactionGroup.id, CollectiveId: transactionGroup.accountId },
            order: [[sequelize.literal(getTransactionKindPriorityCase('Transaction')), 'ASC']],
          });
        },
      },
      createdAt: {
        type: GraphQLDateTime,
      },
    };
  },
});
