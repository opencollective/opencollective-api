import { GraphQLFloat, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLOrderTaxType } from '../enum/OrderTaxType.js';

export const GraphQLTaxInfo = new GraphQLObjectType({
  name: 'TaxInfo',
  description: 'Information about a tax',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'An unique identifier for this tax (GST, VAT, etc)',
    },
    type: {
      type: new GraphQLNonNull(GraphQLOrderTaxType),
      description: 'Identifier for this tax (GST, VAT, etc)',
    },
    percentage: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Percentage applied, between 0-100',
      deprecationReason: 'Please use `rate` instead',
    },
    rate: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Percentage applied, between 0-1',
    },
    idNumber: {
      type: GraphQLString,
      description: 'Tax ID number of the 3rd party receiving/paying the tax',
    },
  }),
});
