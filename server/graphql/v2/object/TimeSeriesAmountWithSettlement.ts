import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { TransactionSettlementStatus } from '../enum/TransactionSettlementStatus';
import { getTimeSeriesFields, TimeSeries } from '../interface/TimeSeries';

import { Amount } from './Amount';

const TimeSeriesAmountWithSettlementNodes = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithSettlementNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    amount: { type: new GraphQLNonNull(Amount) },
    settlementStatus: { type: new GraphQLNonNull(TransactionSettlementStatus) },
  }),
});

export const TimeSeriesAmountWithSettlement = new GraphQLObjectType({
  name: 'TimeSeriesAmountWithSettlement',
  description: 'Amounts with settlements time series',
  interfaces: [TimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TimeSeriesAmountWithSettlementNodes))),
      description: 'Time series data points',
    },
  }),
});
