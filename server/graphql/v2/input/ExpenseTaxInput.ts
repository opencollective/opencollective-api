import { GraphQLFloat, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLTaxType } from '../enum/TaxType.js';

export const GraphQLExpenseTaxInput = new GraphQLInputObjectType({
  name: 'ExpenseTaxInput',
  description: 'Input to set taxes for an expense',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(GraphQLTaxType),
    },
    rate: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Tax rate as a float number between 0 and 1',
    },
    idNumber: {
      type: GraphQLString,
      description: 'Tax identification number, if any',
    },
  }),
});
