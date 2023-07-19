import { TaxType } from '@opencollective/taxes';
import { GraphQLFloat, GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLCountryISO } from '../enum/index.js';
import { COUNTRY_CODES } from '../enum/CountryISO.js';
import { GraphQLTaxType as GraphQLTaxType } from '../enum/TaxType.js';

import { AmountInputType, GraphQLAmountInput } from './AmountInput.js';

export type TaxInput = {
  type: TaxType;
  rate: number;
  idNumber?: string;
  country?: keyof typeof COUNTRY_CODES;
  amount: AmountInputType;
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
    country: {
      type: GraphQLCountryISO,
      description: 'Country ISO code of the entity paying the tax',
    },
    amount: {
      type: GraphQLAmountInput,
      description:
        'An optional tax amount to make sure the tax displayed in your frontend matches the one calculated by the API',
    },
  }),
});
