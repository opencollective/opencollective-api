import { TaxType } from '@opencollective/taxes';
import { GraphQLFloat, GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { TaxType as GraphQLTaxType } from '../enum/TaxType';

export type TaxInput = {
  type: TaxType;
  rate: number;
  idNumber?: string;
};

/**
 * A tax input meant to replace `ExpenseTaxInput` and `OrderTaxInput`.
 */
export const GraphQLTaxInput = new GraphQLInputObjectType({
  name: 'TaxInput',
  description: 'Input to set taxes for an expense',
  fields: (): Record<keyof TaxInput, GraphQLInputFieldConfig> => ({
    type: {
      type: new GraphQLNonNull(GraphQLTaxType),
      description: 'Tax type',
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
