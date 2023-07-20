import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLAmount } from '../object/Amount.js';

export const GraphQLTagStats = new GraphQLObjectType({
  name: 'TagStat',
  description: 'Statistics for a given tag',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'An unique identifier for this tag',
    },
    tag: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Name/Label of the tag',
    },
    count: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of entries for this tag',
    },
    amount: {
      type: GraphQLAmount,
      description: 'Total amount for this tag',
      resolve(entry) {
        if (entry.amount) {
          return { value: entry.amount / 100, currency: entry.currency };
        }
      },
    },
  }),
});
