import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import * as HostMetricsLib from '../../../lib/host-metrics';
import { fetchAccountsWithReferences } from '../input/AccountReferenceInput';

import { TimeSeriesAmount } from './TimeSeriesAmount';
import { TimeSeriesAmountWithSettlement } from './TimeSeriesAmountWithSettlement';

const resultsToAmountNode = results => {
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

export const HostMetricsTimeSeries = new GraphQLObjectType({
  name: 'HostMetricsTimeSeries',
  description: 'Host metrics time series',
  fields: () => ({
    platformTips: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'History of the collected platform tips',
      resolve: async ({ host, dateFrom, dateTo, timeUnit }) => {
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, groupTimeUnit: timeUnit };
        const results = await HostMetricsLib.getPlatformTips(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    hostFees: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'History of the host fees collected',
      resolve: async ({ host, dateFrom, dateTo, timeUnit }) => {
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, timeUnit };
        const results = await HostMetricsLib.getHostFeesTimeSeries(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    hostFeeShare: {
      type: new GraphQLNonNull(TimeSeriesAmountWithSettlement),
      description: 'History of the share of host fees collected owed to Open Collective Inc.',
      resolve: async ({ host, dateFrom, dateTo, timeUnit }) => {
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, timeUnit };
        const results = await HostMetricsLib.getHostFeeShareTimeSeries(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountWithSettlementNode(results) };
      },
    },
    totalMoneyManaged: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'History of the total money managed by this host',
      resolve: async ({ host, account, dateFrom, dateTo, timeUnit }) => {
        let collectiveIds;
        if (account) {
          const collectives = await fetchAccountsWithReferences(account);
          collectiveIds = collectives.map(collective => collective.id);
        }
        const timeSeriesParams = { startDate: dateFrom, endDate: dateTo, collectiveIds, timeUnit };
        const results = await HostMetricsLib.getTotalMoneyManagedTimeSeries(host, timeSeriesParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
  }),
});
