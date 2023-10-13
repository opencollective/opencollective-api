import { GraphQLEnumType } from 'graphql';

export const GraphQLTaxType = new GraphQLEnumType({
  name: 'TaxType',
  description: 'The type of a tax like GST, VAT, etc',
  values: {
    VAT: {
      description: 'European Value Added Tax',
    },
    GST: {
      description: 'New Zealand Good and Services Tax',
    },
    EIN: {
      description: 'Employer Identification Number',
    },
  },
});
