import { GraphQLEnumType } from 'graphql';

export const OrderStatus = new GraphQLEnumType({
  name: 'OrderStatus',
  description: 'All order statuses',
  values: {
    ACTIVE: {},
    CANCELLED: {},
    DISPUTED: {},
    ERROR: {},
    EXPIRED: {},
    NEW: {},
    PAID: {},
    PENDING: {},
    PLEDGED: {},
    REFUNDED: {},
    REJECTED: {},
    REQUIRE_CLIENT_CONFIRMATION: {},
  },
});
