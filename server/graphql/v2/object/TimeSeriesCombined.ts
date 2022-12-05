import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getTimeSeriesFields, TimeSeries } from '../interface/TimeSeries';

import { Amount } from './Amount';

const TimeSeriesCombinedNode = new GraphQLObjectType({
  name: 'TimeSeriesCombinedNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    totalNetRaised: { type: new GraphQLNonNull(Amount) },
    totalSpent: { type: new GraphQLNonNull(Amount) },
    contributions: { type: GraphQLInt },
    contributors: { type: GraphQLInt },
  }),
});

export const TimeSeriesCombined = new GraphQLObjectType({
  name: 'TimeSeriesCombined',
  description: 'Combined time series of net raised, spent, contributors and contributions',
  interfaces: [TimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TimeSeriesCombinedNode))),
      description: 'Time series data points',
    },
  }),
});
