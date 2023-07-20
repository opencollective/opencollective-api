import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods.js';

export const GraphQLPaymentMethodType = new GraphQLEnumType({
  name: 'PaymentMethodType',
  values: {
    ...Object.values(PAYMENT_METHOD_TYPE).reduce(
      (values, key) => ({ ...values, [key]: { deprecationReason: 'Please use uppercase values' } }),
      {},
    ),
    ...Object.keys(PAYMENT_METHOD_TYPE).reduce(
      (values, key) => ({ ...values, [key]: { value: PAYMENT_METHOD_TYPE[key] } }),
      {},
    ),
  },
});
