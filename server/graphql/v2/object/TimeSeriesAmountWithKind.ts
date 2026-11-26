import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { PARENT_LIMIT } from '../../cost/extensions';
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
      // Not paginated: one per time unit (and kind) in the date range. The fields that return a time series
      // declare that number in their `listSize`, with `getTimeSeriesListSize`.
      extensions: { cost: { listSize: PARENT_LIMIT } },
      description: 'Time series data points',
    },
  }),
});
