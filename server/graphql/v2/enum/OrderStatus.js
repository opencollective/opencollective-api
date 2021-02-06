import { GraphQLEnumType } from 'graphql';

export const OrderStatus = new GraphQLEnumType({
  name: 'OrderStatus',
  description: 'All order statuses',
  values: {
    ACTIVE: {},
    CANCELLED: {},
    ERROR: {},
    EXPIRED: {},
    NEW: {},
    PAID: {},
    PENDING: {},
    PLEDGED: {},
    REJECTED: {},
    REQUIRE_CLIENT_CONFIRMATION: {},
  },
});
