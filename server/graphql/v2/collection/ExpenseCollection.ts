import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
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
  }),
});
