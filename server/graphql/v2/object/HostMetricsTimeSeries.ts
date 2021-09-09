import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { getHostFees, getHostFeeShare, getPlatformTips } from '../../../lib/host-metrics';

import { TimeSeriesAmount } from './TimeSeriesAmount';

const resultsToAmountNode = results => {
  return results.map(result => ({
    date: result.date,
    amount: { value: result.amount, currency: result.currency },
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
        const results = await getPlatformTips(host, { startDate, endDate, groupTimeUnit: timeUnit });
        return { startDate, endDate, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    hostFees: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'History of the host fees collected',
      resolve: async ({ host, startDate, endDate, timeUnit }) => {
        const results = await getHostFees(host, { startDate, endDate, groupTimeUnit: timeUnit });
        return { startDate, endDate, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
    hostFeeShare: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'History of the host fees collected',
      resolve: async ({ host, startDate, endDate, timeUnit }) => {
        const results = await getHostFeeShare(host, { startDate, endDate, groupTimeUnit: timeUnit });
        return { startDate, endDate, timeUnit, nodes: resultsToAmountNode(results) };
      },
    },
  }),
});
