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
    IN_REVIEW: {},
    NEW: {},
    PAID: {},
    PENDING: {},
    PROCESSING: {},
    PLEDGED: {},
    REFUNDED: {},
    REJECTED: {},
    REQUIRE_CLIENT_CONFIRMATION: {},
  },
});
