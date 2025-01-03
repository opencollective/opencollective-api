import { GraphQLFloat, GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { GraphQLTaxType } from '../enum/TaxType';

export const GraphQLOrderTax = new GraphQLObjectType({
  name: 'OrderTax',
  fields: () => {
    return {
      type: {
        type: new GraphQLNonNull(GraphQLTaxType),
      },
      percentage: {
        type: new GraphQLNonNull(GraphQLInt),
        deprecationReason: 'Please use `rate` instead',
      },
      rate: {
        type: new GraphQLNonNull(GraphQLFloat),
        description: 'Percentage applied, between 0-1',
      },
    };
  },
});
