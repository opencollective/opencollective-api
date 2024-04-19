import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { getTimeSeriesFields } from '../interface/TimeSeries';

import { GraphQLTransactionReport } from './TransactionReport';

export const GraphQLTransactionReports = new GraphQLObjectType({
  name: 'TransactionReports',
  description: 'EXPERIMENTAL (this may change or be deleted): Host transaction report',
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLTransactionReport)),
    },
  }),
});
