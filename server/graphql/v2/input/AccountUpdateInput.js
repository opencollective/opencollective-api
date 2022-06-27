import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { Currency } from '../enum/Currency';

export const AccountUpdateInput = new GraphQLInputObjectType({
  name: 'AccountUpdateInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id identifying the account (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    currency: { type: Currency },
  }),
});
