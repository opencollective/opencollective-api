import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import queries from '../../../lib/queries';
import { getTimeSeriesFields } from '../interface/TimeSeries';
import { resultsToAmountNode } from '../object/HostMetricsTimeSeries';
import { TimeSeriesAmount } from '../object/TimeSeriesAmount';
import { TimeSeriesCount } from '../object/TimeSeriesCount';

const resultsToCountNode = results => {
  return results.map(result => ({
    date: result.date,
    count: result.count,
  }));
};

export const AccountCollectionStats = new GraphQLObjectType({
  name: 'AccountCollectionStats',
  description: 'Account collection stats',
  fields: () => ({
    ...getTimeSeriesFields(),
    contributionsCountTimeSeries: {
      type: new GraphQLNonNull(TimeSeriesCount),
      description: 'Time series of the number of contributions to these accounts',
      resolve: async ({ collectiveIds, dateFrom, dateTo, timeUnit }) => {
        const kind = [TransactionKind.CONTRIBUTION];
        const transactionParams = { type: TransactionTypes.CREDIT, kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = await queries.getTransactionsCountTimeSeries(timeUnit, transactionParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToCountNode(amountDataPoints) };
      },
    },
    totalReceivedTimeSeries: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'Time series of the total money received by these accounts',
      resolve: async ({ collectiveIds, dateFrom, dateTo, timeUnit }) => {
        const kind = [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS];
        const transactionParams = { type: TransactionTypes.CREDIT, kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = await queries.getTransactionsTimeSeries(timeUnit, transactionParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(amountDataPoints) };
      },
    },
  }),
});
