import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { Amount } from '../object/Amount';

export const TagStats = new GraphQLObjectType({
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
      type: new GraphQLNonNull(Amount),
      description: 'Total amount for this tag',
      resolve(entry) {
        if (entry.amount) {
          return { value: entry.amount / 100, currency: entry.currency };
        }
      },
    },
  }),
});
