import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getTimeSeriesFields } from '../interface/TimeSeries';

import { GraphQLAccountingCategory } from './AccountingCategory';
import { GraphQLAmount } from './Amount';

const GraphQLHostExpensesReportNodes = new GraphQLObjectType({
  name: 'HostExpensesReportNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    isHost: {
      type: new GraphQLNonNull(GraphQLBoolean),
    },
    accountingCategory: {
      type: GraphQLAccountingCategory,
      async resolve({ AccountingCategoryId }, _, req) {
        if (AccountingCategoryId) {
          return req.loaders.AccountingCategory.byId.load(AccountingCategoryId);
        }
      },
    },
    amount: {
      type: new GraphQLNonNull(GraphQLAmount),
      resolve({ amount, currency }) {
        return {
          value: amount,
          currency,
        };
      },
    },
    count: {
      type: new GraphQLNonNull(GraphQLInt),
    },
  }),
});

export const GraphQLHostExpensesReports = new GraphQLObjectType({
  name: 'HostExpensesReports',
  description: 'EXPERIMENTAL (this may change or be deleted): Host expenses report',
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLHostExpensesReportNodes)),
    },
  }),
});
