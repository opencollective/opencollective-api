import { GraphQLEnumType } from 'graphql';

import PaymentIntentStatus from '../../../constants/payment-intent-status';

const GraphQLPaymentIntentStatus = new GraphQLEnumType({
  name: 'PaymentIntentStatus',
  values: Object.values(PaymentIntentStatus).reduce((values, key) => {
    return { ...values, [key]: { value: PaymentIntentStatus[key] } };
  }, {}),
});

export default GraphQLPaymentIntentStatus;
