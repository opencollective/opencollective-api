import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLTransactionKind } from '../enum/TransactionKind';
import { getTimeSeriesFields, GraphQLTimeSeries } from '../interface/TimeSeries';

import { GraphQLAmount } from './Amount';

const GraphQLTimeSeriesAmountWithKindNodes = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithKindNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    amount: { type: new GraphQLNonNull(GraphQLAmount) },
    kind: { type: new GraphQLNonNull(GraphQLTransactionKind) },
  }),
});

export const GraphQLTimeSeriesAmountWithKind = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithKind',
  description: 'Amounts with settlements time series',
  interfaces: [GraphQLTimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLTimeSeriesAmountWithKindNodes))),
      description: 'Time series data points',
    },
  }),
});
