import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { isNil } from 'lodash';

import { GraphQLAmount } from '../object/Amount';

export const GraphQLAmountStats = new GraphQLObjectType({
  name: 'AmountStats',
  description: 'Statistics with amounts',
  fields: () => ({
    label: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Name/Label for the amount',
    },
    amount: {
      type: new GraphQLNonNull(GraphQLAmount),
      description: 'Total amount for this label',
      resolve(entry) {
        if (!isNil(entry.amount)) {
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
