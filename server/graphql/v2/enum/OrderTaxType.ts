import { GraphQLEnumType } from 'graphql';

/**
 * @deprecated Please use `TaxType` instead
 */
export const GraphQLOrderTaxType = new GraphQLEnumType({
  name: 'OrderTaxType',
  description: 'The type of a tax like GST, VAT, etc',
  values: {
    VAT: {
      description: 'European Value Added Tax',
    },
    GST: {
      description: 'New Zealand Good and Services Tax',
    },
  },
});
