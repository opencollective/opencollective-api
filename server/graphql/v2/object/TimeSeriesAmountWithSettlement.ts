import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLTransactionSettlementStatus } from '../enum/TransactionSettlementStatus.js';
import { getTimeSeriesFields, GraphQLTimeSeries } from '../interface/TimeSeries.js';

import { GraphQLAmount } from './Amount.js';

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
      description: 'Time series data points',
    },
  }),
});
