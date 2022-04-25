import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { TransactionKind } from '../enum/TransactionKind';
import { getTimeSeriesFields, TimeSeries } from '../interface/TimeSeries';

import { Amount } from './Amount';

const TimeSeriesAmountWithKindNodes = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithKindNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    amount: { type: new GraphQLNonNull(Amount) },
    kind: { type: new GraphQLNonNull(TransactionKind) },
  }),
});

export const TimeSeriesAmountWithKind = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithKind',
  description: 'Amounts with settlements time series',
  interfaces: [TimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TimeSeriesAmountWithKindNodes))),
      description: 'Time series data points',
    },
  }),
});
