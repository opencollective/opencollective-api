import { GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { OrderTaxType } from '../enum/OrderTaxType';

export const OrderTax = new GraphQLObjectType({
  name: 'OrderTax',
  fields: () => {
    return {
      type: {
        type: new GraphQLNonNull(OrderTaxType),
      },
      percentage: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    };
  },
});
