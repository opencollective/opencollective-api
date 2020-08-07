import { GraphQLEnumType } from 'graphql';

export const PaymentMethodType = new GraphQLEnumType({
  name: 'PaymentMethodType',
  values: {
    CREDIT_CARD: {},
    GIFT_CARD: {},
    PREPAID_BUDGET: {},
    COLLECTIVE_BALANCE: {},
    PAYPAL: {},
    BANK_TRANSFER: {},
  },
});
