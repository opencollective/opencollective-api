import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import * as HostMetricsLib from '../../../lib/host-metrics';
import { getTimeSeriesFields } from '../interface/TimeSeries';

import { GraphQLTimeSeriesAmount } from './TimeSeriesAmount';
import { GraphQLTimeSeriesAmountWithKind } from './TimeSeriesAmountWithKind';
import { GraphQLTimeSeriesAmountWithSettlement } from './TimeSeriesAmountWithSettlement';

export const resultsToAmountNode = results => {
  return results.map(result => ({
    date: result.date,
    amount: { value: result.amount, currency: result.currency },
  }));
};

const resultsToAmountWithSettlementNode = results => {
  return results.map(result => ({
    date: result.date,
    amount: { value: result.amount, currency: result.currency },
    settlementStatus: result.settlementStatus,
  }));
};

const resultsToAmountWithKindNode = results => {
  return results.map(result => ({
    date: result.date,
    amount: { value: result.amount, currency: result.currency },
    kind: result.kind,
  }));
};

export const GraphQLHostMetricsTimeSeries = new GraphQLObjectType({
  name: 'HostMetricsTimeSeries',
  description: 'Host metrics time series',
  fields: () => ({
    ...getTimeSeriesFields(),
    platformTips: {
      type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
      description: 'History of the collected platform tips',
      resolve: async ({ host, dateFrom, dateTo, timeUnit }) => {
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, groupTimeUnit: timeUnit };
        const results = await HostMetricsLib.getPlatformTips(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    hostFees: {
      type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
      description: 'History of the host fees collected',
      resolve: async ({ host, dateFrom, dateTo, timeUnit }) => {
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, timeUnit };
        const results = await HostMetricsLib.getHostFeesTimeSeries(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    hostFeeShare: {
      type: new GraphQLNonNull(GraphQLTimeSeriesAmountWithSettlement),
      description: 'History of the share of host fees collected owed to Open Collective Inc.',
      resolve: async ({ host, dateFrom, dateTo, timeUnit }) => {
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, timeUnit };
        const results = await HostMetricsLib.getHostFeeShareTimeSeries(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountWithSettlementNode(results) };
      },
    },
    totalMoneyManaged: {
      type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
      description: 'History of the total money managed by this host',
      resolve: async ({ host, collectiveIds, dateFrom, dateTo, timeUnit }) => {
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, collectiveIds, timeUnit };
        const results = await HostMetricsLib.getTotalMoneyManagedTimeSeries(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    totalReceived: {
      type: new GraphQLNonNull(GraphQLTimeSeriesAmountWithKind),
      description: 'History of the total money received by this host',
      resolve: async ({ host, collectiveIds, dateFrom, dateTo, timeUnit }) => {
        const kind = [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS];
        const transactionParams = { type: TransactionTypes.CREDIT, kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = await HostMetricsLib.getTransactionsTimeSeriesByKind(
          host.id,
          timeUnit,
          transactionParams,
        );
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountWithKindNode(amountDataPoints) };
      },
    },
    totalSpent: {
      type: new GraphQLNonNull(GraphQLTimeSeriesAmountWithKind),
      description: 'History of the total money spent by this host',
      resolve: async ({ host, collectiveIds, dateFrom, dateTo, timeUnit }) => {
        const kind = TransactionKind.EXPENSE;
        const transactionParams = { type: TransactionTypes.DEBIT, kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = await HostMetricsLib.getTransactionsTimeSeriesByKind(
          host.id,
          timeUnit,
          transactionParams,
        );
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountWithKindNode(amountDataPoints) };
      },
    },
  }),
});
