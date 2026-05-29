import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { GraphQLCurrency } from '../enum';
import { CollectionArgs, CollectionFields, GraphQLCollection } from '../interface/Collection';
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
    totalAmount: {
      type: new GraphQLObjectType({
        name: 'ExpenseCollectionTotalAmount',
        fields: {
          amount: {
            args: {
              currency: {
                type: GraphQLCurrency,
                defaultValue: 'USD',
              },
            },
            type: GraphQLAmount,
          },
          amountsByCurrency: {
            type: new GraphQLList(GraphQLAmount),
          },
        },
      }),
    },
    payees: {
      type: new GraphQLNonNull(GraphQLAccountCollection),
      description:
        'The accounts that are payees of the expenses in this collection (scoped to the main query arguments), regardless of pagination. Returns a paginated and searchable collection.',
      args: {
        ...CollectionArgs,
        searchTerm: {
          type: GraphQLString,
          description: 'Search term to filter by name or slug',
        },
      },
    },
  }),
});
