import { GraphQLNonNull, GraphQLString } from 'graphql';

import { getFxRate } from '../../../lib/currency';
import { sequelize, Transaction } from '../../../models';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLTransactionGroup } from '../object/TransactionGroup';

import { getTransactionKindPriorityCase } from './collection/TransactionsCollectionQuery';

const TransactionGroupQuery = {
  type: GraphQLTransactionGroup,
  description: '[!] Warning: this query is currently in beta and the API might change',
  args: {
    groupId: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id identifying the transaction group (ie: rvelja97-pkzqbgq7-bbzyx6wd-50o8n4rm)',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'Account associated to the transaction group',
    },
  },
  async resolve(_, args) {
    if (!args.account) {
      throw new Error('You need to provide an account argument');
    }
    if (!args.groupId) {
      throw new Error('You need to provide the groupId');
    }
    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    const CollectiveId = account.id;

    const transactions = await Transaction.findAll({
      where: {
        CollectiveId,
        TransactionGroup: args.groupId,
      },
      order: [[sequelize.literal(getTransactionKindPriorityCase('Transaction')), 'ASC']],
    });

    const primaryTransaction = transactions[0]; // First transaction based on the ordering using getTransactionKindPriorityCase
    const convertedAmounts = await Promise.all(
      transactions.map(async t => {
        const fxRate = await getFxRate(t.currency, account.currency, t.createdAt);
        return Math.round(t.netAmountInCollectiveCurrency * fxRate);
      }),
    );
    const totalAmountInAccountCurrency = convertedAmounts.reduce((total, amount) => total + amount, 0);

    return {
      id: args.groupId,
      account: account,
      totalAmount: {
        value: totalAmountInAccountCurrency,
        currency: account.currency,
      },
      primaryTransactionId: primaryTransaction.id,
      transactions: transactions,
      accountId: account.id,
      createdAt: primaryTransaction.createdAt,
    };
  },
};

export default TransactionGroupQuery;
