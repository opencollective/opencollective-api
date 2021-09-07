import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { getPlatformTips } from '../../../lib/host-metrics';

import { TimeSeriesAmount } from './TimeSeriesAmount';

export const HostMetricsTimeSeries = new GraphQLObjectType({
  name: 'HostMetricsTimeSeries',
  description: 'Host metrics time series',
  fields: () => ({
    platformTips: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'History of the collected platform tips',
      resolve: async ({ host, startDate, endDate, timeUnit }) => {
        const results = await getPlatformTips(host, { startDate, endDate, groupTimeUnit: timeUnit });
        return {
          startDate,
          endDate,
          timeUnit,
          nodes: results.map(result => ({
            date: result.date,
            amount: { value: result.amount, currency: result.currency },
          })),
        };
      },
    },
  }),
});
