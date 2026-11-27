import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';

const DEPRECATED_VALUES: readonly PAYMENT_METHOD_TYPE[] = [PAYMENT_METHOD_TYPE.BITCOIN];

const getDeprecationReason = (value: PAYMENT_METHOD_TYPE): string | undefined =>
  DEPRECATED_VALUES.includes(value) ? 'This payment method type is not supported anymore' : undefined;

export const GraphQLPaymentMethodType = new GraphQLEnumType({
  name: 'PaymentMethodType',
  values: {
    ...Object.values(PAYMENT_METHOD_TYPE).reduce(
      (values, value) => ({
        ...values,
        [value]: { deprecationReason: getDeprecationReason(value) || 'Please use uppercase values' },
      }),
      {},
    ),
    ...(Object.keys(PAYMENT_METHOD_TYPE) as (keyof typeof PAYMENT_METHOD_TYPE)[]).reduce(
      (values, key) => ({
        ...values,
        [key]: { value: PAYMENT_METHOD_TYPE[key], deprecationReason: getDeprecationReason(PAYMENT_METHOD_TYPE[key]) },
      }),
      {},
    ),
  },
});
