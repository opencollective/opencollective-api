import { GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { GraphQLOrderTaxType } from '../enum/OrderTaxType';

export const GraphQLOrderTax = new GraphQLObjectType({
  name: 'OrderTax',
  fields: () => {
    return {
      type: {
        type: new GraphQLNonNull(GraphQLOrderTaxType),
      },
      percentage: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    };
  },
});
