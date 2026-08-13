import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';

const deprecatedValues: readonly PAYMENT_METHOD_TYPE[] = [PAYMENT_METHOD_TYPE.BITCOIN] as const;

export const GraphQLPaymentMethodType = new GraphQLEnumType({
  name: 'PaymentMethodType',
  values: {
    ...Object.values(PAYMENT_METHOD_TYPE).reduce(
      (values, key) => ({ ...values, [key]: { deprecationReason: 'Please use uppercase values' } }),
      {},
    ),
    ...Object.keys(PAYMENT_METHOD_TYPE).reduce(
      (values, key: PAYMENT_METHOD_TYPE) => ({
        ...values,
        [key]: {
          deprecationReason: deprecatedValues.includes(key) ? 'This value is deprecated' : undefined,
          value: PAYMENT_METHOD_TYPE[key],
        },
      }),
      {},
    ),
  },
});
