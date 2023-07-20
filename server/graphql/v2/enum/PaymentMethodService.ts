import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_SERVICE } from '../../../constants/paymentMethods.js';

export const GraphQLPaymentMethodService = new GraphQLEnumType({
  name: 'PaymentMethodService',
  values: Object.keys(PAYMENT_METHOD_SERVICE).reduce(
    (values, key) => ({ ...values, [key]: { value: PAYMENT_METHOD_SERVICE[key] } }),
    {},
  ),
});
