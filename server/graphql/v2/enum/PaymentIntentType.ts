import { GraphQLEnumType } from 'graphql';

import PaymentIntentType from '../../../constants/payment-intent-type';

const GraphQLPaymentIntentType = new GraphQLEnumType({
  name: 'PaymentIntentType',
  values: Object.values(PaymentIntentType).reduce((values, key) => {
    return { ...values, [key]: { value: PaymentIntentType[key] } };
  }, {}),
});

export default GraphQLPaymentIntentType;
