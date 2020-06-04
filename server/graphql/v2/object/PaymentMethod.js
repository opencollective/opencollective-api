import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';

import { idEncode } from '../identifiers';

export const PaymentMethod = new GraphQLObjectType({
  name: 'PaymentMethod',
  description: 'PaymentMethod model',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        resolve(paymentMethod) {
          return idEncode(paymentMethod.id, 'paymentMethod');
        },
      },
      legacyId: {
        type: GraphQLInt,
        resolve(paymentMethod) {
          return paymentMethod.id;
        },
      },
      name: {
        // last 4 digit of card number for Stripe
        type: GraphQLString,
        resolve(paymentMethod) {
          return paymentMethod.name;
        },
      },
    };
  },
});
