import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Expense } from '../object/Expense';

const ExpenseCollection = new GraphQLObjectType({
  name: 'ExpenseCollection',
  interfaces: [Collection],
  description: 'A collection of "Expenses"',
  fields: {
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(Expense),
    },
  },
});

export { ExpenseCollection };
