import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { Amount } from '../object/Amount';

export const AmountStats = new GraphQLObjectType({
  name: 'AmountStats',
  description: 'Statistics aith amounts',
  fields: () => ({
    label: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Name/Label for the amount',
    },
    amount: {
      type: new GraphQLNonNull(Amount),
      description: 'Total amount for this label',
      resolve(entry) {
        if (entry.amount) {
          return { value: entry.amount, currency: entry.currency };
        }
      },
    },
    count: {
      type: GraphQLInt,
      description: 'Number of entries for this label',
    },
  }),
});
