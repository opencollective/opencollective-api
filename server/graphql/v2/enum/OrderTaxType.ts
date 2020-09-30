import { GraphQLEnumType } from 'graphql';

export const OrderTaxType = new GraphQLEnumType({
  name: 'OrderTaxType',
  description: 'Type for a required legal document',
  values: {
    VAT: {
      description: 'European Value Added Tax',
    },
    GST: {
      description: 'New Zealand Good and Services Tax',
    },
  },
});
