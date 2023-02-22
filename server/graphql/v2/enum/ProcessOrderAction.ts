import { GraphQLEnumType } from 'graphql';

export const GraphQLProcessOrderAction = new GraphQLEnumType({
  name: 'ProcessOrderAction',
  description: 'Action to apply on the order',
  values: {
    MARK_AS_EXPIRED: {
      description: 'To mark the order as expired',
    },
    MARK_AS_PAID: {
      description: 'To mark the order as paid',
    },
  },
});
