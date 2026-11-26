import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { PARENT_LIMIT } from '../../cost/extensions';
import { GraphQLTransactionSettlementStatus } from '../enum/TransactionSettlementStatus';
import { getTimeSeriesFields, GraphQLTimeSeries } from '../interface/TimeSeries';

import { GraphQLAmount } from './Amount';

const GraphQLTimeSeriesAmountWithSettlementNodes = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithSettlementNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    amount: { type: new GraphQLNonNull(GraphQLAmount) },
    settlementStatus: { type: new GraphQLNonNull(GraphQLTransactionSettlementStatus) },
  }),
});

export const GraphQLTimeSeriesAmountWithSettlement = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithSettlement',
  description: 'Amounts with settlements time series',
  interfaces: [GraphQLTimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLTimeSeriesAmountWithSettlementNodes))),
      // Not paginated: one per time unit (and settlement status) in the date range. The fields that return a time series
      // declare that number in their `listSize`, with `getTimeSeriesListSize`.
      extensions: { cost: { listSize: PARENT_LIMIT } },
      description: 'Time series data points',
    },
  }),
});
