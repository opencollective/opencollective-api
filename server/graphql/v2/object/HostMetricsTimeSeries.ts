import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import * as HostMetricsLib from '../../../lib/host-metrics';

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
      resolve: async ({ host, startDate, endDate, timeUnit }) => {
        const results = await HostMetricsLib.getPlatformTips(host, { startDate, endDate, groupTimeUnit: timeUnit });
        return { startDate, endDate, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    hostFees: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'History of the host fees collected',
      resolve: async ({ host, startDate, endDate, timeUnit }) => {
        const timeSeriesParams = { startDate, endDate, timeUnit };
        const results = await HostMetricsLib.getHostFeesTimeSeries(host, timeSeriesParams);
        return { ...timeSeriesParams, nodes: resultsToAmountNode(results) };
      },
    },
    hostFeeShare: {
      type: new GraphQLNonNull(TimeSeriesAmountWithSettlement),
      description: 'History of the share of host fees collected owed to Open Collective Inc.',
      resolve: async ({ host, startDate, endDate, timeUnit }) => {
        const timeSeriesParams = { startDate, endDate, timeUnit };
        const results = await HostMetricsLib.getHostFeeShareTimeSeries(host, timeSeriesParams);
        return { ...timeSeriesParams, nodes: resultsToAmountWithSettlementNode(results) };
      },
    },
  }),
});
