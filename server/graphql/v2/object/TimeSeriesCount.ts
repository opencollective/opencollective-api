import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getTimeSeriesFields, TimeSeries } from '../interface/TimeSeries';

const TimeSeriesCountNode = new GraphQLObjectType({
  name: 'TimeSeriesCountNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
  }),
});

export const TimeSeriesCount = new GraphQLObjectType({
  name: 'TimeSeriesCount',
  description: 'Count time series',
  interfaces: [TimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TimeSeriesCountNode))),
      description: 'Time series data points',
    },
  }),
});
