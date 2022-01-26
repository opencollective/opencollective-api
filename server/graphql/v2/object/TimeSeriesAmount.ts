import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getTimeSeriesFields, TimeSeries } from '../interface/TimeSeries';

import { Amount } from './Amount';

const TimeSeriesAmountNodes = new GraphQLObjectType({
  name: 'TimeSeriesAmountNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    amount: { type: new GraphQLNonNull(Amount) },
  }),
});

export const TimeSeriesAmount = new GraphQLObjectType({
  name: 'TimeSeriesAmount',
  description: 'Amount time series',
  interfaces: [TimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TimeSeriesAmountNodes))),
      description: 'Time series data points',
    },
  }),
});
