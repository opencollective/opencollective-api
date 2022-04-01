import { GraphQLFloat, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { TaxType } from '../enum/TaxType';

export const ExpenseTaxInput = new GraphQLInputObjectType({
  name: 'ExpenseTaxInput',
  description: 'Input to set taxes for an expense',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(TaxType),
    },
    rate: {
      type: new GraphQLNonNull(GraphQLFloat),
    },
    idNumber: {
      type: GraphQLString,
      description: 'Tax identification number, if any',
    },
  }),
});
