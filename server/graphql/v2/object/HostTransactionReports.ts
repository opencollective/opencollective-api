import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLExpenseType } from '../enum/ExpenseType';
import { GraphQLTransactionKind } from '../enum/TransactionKind';
import { GraphQLTransactionType } from '../enum/TransactionType';
import { getTimeSeriesFields } from '../interface/TimeSeries';

import { GraphQLAmount } from './Amount';

const GraphQLTransactionsGroup = new GraphQLObjectType({
  name: 'TransactionGroup',
  description:
    'EXPERIMENTAL (this may change or be deleted): Transaction amounts grouped by type, kind, isRefund, isHost, expenseType',
  fields: () => ({
    amount: { type: GraphQLAmount },
    netAmount: { type: GraphQLAmount },
    platformFees: { type: GraphQLAmount },
    paymentProcessorFees: { type: GraphQLAmount },
    hostFees: { type: GraphQLAmount },
    taxAmount: { type: GraphQLAmount },
    type: { type: GraphQLTransactionType },
    kind: { type: GraphQLTransactionKind },
    isRefund: { type: GraphQLBoolean },
    isHost: { type: GraphQLBoolean },
    expenseType: { type: GraphQLExpenseType },
  }),
});

const GraphQLTransactionsReport = new GraphQLObjectType({
  name: 'TransactionsReport',
  description: 'Transactions report',
  fields: () => ({
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
      type: new GraphQLNonNull(new GraphQLList(GraphQLTransactionsGroup)),
    },
  }),
});

const GraphQLHostTransactionReportNodes = new GraphQLObjectType({
  name: 'HostTransactionReportNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    managedFunds: {
      type: new GraphQLNonNull(GraphQLTransactionsReport),
    },
    managedInactiveFunds: {
      type: new GraphQLNonNull(GraphQLTransactionsReport),
    },
    operationalFunds: {
      type: new GraphQLNonNull(GraphQLTransactionsReport),
    },
  }),
});

export const GraphQLHostTransactionReports = new GraphQLObjectType({
  name: 'HostTransactionReports',
  description: 'EXPERIMENTAL (this may change or be deleted): Host transaction report',
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLHostTransactionReportNodes)),
    },
  }),
});
