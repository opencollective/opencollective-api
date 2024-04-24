import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLExpenseType } from '../enum/ExpenseType';
import { GraphQLTransactionKind } from '../enum/TransactionKind';
import { GraphQLTransactionType } from '../enum/TransactionType';

import { GraphQLAmount } from './Amount';

const GraphQLTransactionsAmountGroup = new GraphQLObjectType({
  name: 'TransactionsAmountGroup',
  description:
    'EXPERIMENTAL (this may change or be deleted): Transaction amounts grouped by type, kind, isRefund, isHost, expenseType',
  fields: () => ({
    netAmount: { type: GraphQLAmount },
    amount: { type: GraphQLAmount },
    platformFee: { type: GraphQLAmount },
    paymentProcessorFee: { type: GraphQLAmount },
    hostFee: { type: GraphQLAmount },
    taxAmount: { type: GraphQLAmount },
    type: { type: GraphQLTransactionType },
    kind: { type: GraphQLTransactionKind },
    isRefund: { type: GraphQLBoolean },
    isHost: { type: GraphQLBoolean },
    expenseType: { type: GraphQLExpenseType },
  }),
});

export const GraphQLTransactionReport = new GraphQLObjectType({
  name: 'TransactionReport',
  description: 'EXPERIMENTAL (this may change or be deleted)',
  fields: () => ({
    date: { type: GraphQLDateTime },
    startingBalance: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    endingBalance: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    totalChange: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    groups: {
      type: new GraphQLNonNull(new GraphQLList(GraphQLTransactionsAmountGroup)),
    },
  }),
});
