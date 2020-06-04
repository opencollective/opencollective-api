import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { PaymentMethodDataInput } from './PaymentMethodDataInput';

export const PaymentMethodCreateInput = new GraphQLInputObjectType({
  name: 'PaymentMethodCreateInput',
  fields: () => ({
    data: { type: PaymentMethodDataInput },
    name: { type: GraphQLString },
    token: { type: GraphQLString },
  }),
});
