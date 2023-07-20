import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLCurrency } from '../enum/Currency.js';

export const GraphQLAccountUpdateInput = new GraphQLInputObjectType({
  name: 'AccountUpdateInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id identifying the account (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    currency: { type: GraphQLCurrency },
  }),
});
