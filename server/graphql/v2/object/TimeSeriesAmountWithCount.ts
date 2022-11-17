import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getTimeSeriesFields, TimeSeries } from '../interface/TimeSeries';

import { Amount } from './Amount';

const TimeSeriesAmountWithCountNodes = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithCountNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    amount: { type: new GraphQLNonNull(Amount) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
  }),
});

export const TimeSeriesAmountWithCount = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithCount',
  description: 'Amounts with count time series',
  interfaces: [TimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TimeSeriesAmountWithCountNodes))),
      description: 'Time series data points',
    },
  }),
});
