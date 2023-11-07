import { GraphQLList, GraphQLObjectType } from 'graphql';

import { GraphQLCurrency } from '../enum';
import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLAmount } from '../object/Amount';
import { GraphQLExpense } from '../object/Expense';

export const GraphQLExpenseCollection = new GraphQLObjectType({
  name: 'ExpenseCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Expenses"',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLExpense),
    },
    aggregation: {
      type: new GraphQLObjectType({
        name: 'ExpenseCollectionAggregation',
        fields: {
          totalAmount: {
            args: {
              currency: {
                type: GraphQLCurrency,
                defaultValue: 'USD',
              },
            },
            type: GraphQLAmount,
          },
          currencyAmounts: {
            type: new GraphQLList(GraphQLAmount),
          },
        },
      }),
    },
  }),
});
