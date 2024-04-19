import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getTimeSeriesFields } from '../interface/TimeSeries';

import { GraphQLTransactionReport } from './TransactionReport';

const GraphQLHostTransactionReportNodes = new GraphQLObjectType({
  name: 'HostTransactionReportNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    managedFunds: {
      type: new GraphQLNonNull(GraphQLTransactionReport),
    },
    operationalFunds: {
      type: new GraphQLNonNull(GraphQLTransactionReport),
    },
  }),
});

export const GraphQLHostTransactionReports = new GraphQLObjectType({
  name: 'HostTransactionReports',
  description: 'EXPERIMENTAL (this may change or be deleted): Host transaction report',
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLHostTransactionReportNodes)),
    },
  }),
});
