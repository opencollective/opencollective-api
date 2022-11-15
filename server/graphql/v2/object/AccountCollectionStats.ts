import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import moment from 'moment';

import queries from '../../../lib/queries';
import { TransactionKind } from '../enum/TransactionKind';
import { TransactionType } from '../enum/TransactionType';
import { resultsToAmountNode } from '../object/HostMetricsTimeSeries';
import { getNumberOfDays, getTimeUnit, TimeSeriesAmount, TimeSeriesArgs } from '../object/TimeSeriesAmount';
import { TimeSeriesCount } from '../object/TimeSeriesCount';

export const AccountCollectionStats = new GraphQLObjectType({
  name: 'AccountCollectionStats',
  description: 'Account collection stats',
  fields: () => ({
    transactionsCountTimeSeries: {
      type: new GraphQLNonNull(TimeSeriesCount),
      args: {
        ...TimeSeriesArgs,
        kind: {
          type: new GraphQLList(TransactionKind),
          description: 'To filter by transaction kind',
        },
        type: {
          type: TransactionType,
          description: 'The transaction type (DEBIT or CREDIT)',
        },
      },
      description: 'Time series of the number of contributions to these accounts',
      resolve: async ({ collectiveIds }, args) => {
        const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
        const dateTo = args.dateTo ? moment(args.dateTo) : null;
        const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, {}) || 1);

        const transactionParams = { type: args.type, kind: args.kind, dateFrom, dateTo, collectiveIds };
        const countNodes = collectiveIds.length
          ? await queries.getTransactionsCountTimeSeries(timeUnit, transactionParams)
          : [];
        return { dateFrom, dateTo, timeUnit, nodes: countNodes };
      },
    },
    transactionsTimeSeries: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      args: {
        ...TimeSeriesArgs,
        kind: {
          type: new GraphQLList(TransactionKind),
          description: 'To filter by transaction kind',
        },
        type: {
          type: TransactionType,
          description: 'The transaction type (DEBIT or CREDIT)',
        },
      },
      description: 'Time series of the total money received by these accounts',
      resolve: async ({ collectiveIds }, args) => {
        const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
        const dateTo = args.dateTo ? moment(args.dateTo) : null;
        const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, {}) || 1);

        const transactionParams = { type: args.type, kind: args.kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = collectiveIds.length
          ? await queries.getTransactionsTimeSeries(timeUnit, transactionParams)
          : [];
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(amountDataPoints) };
      },
    },
  }),
});
