import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_TYPES } from '../../../constants/paymentMethods';

export const PaymentMethodType = new GraphQLEnumType({
  name: 'PaymentMethodType',
  values: PAYMENT_METHOD_TYPES.reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});
