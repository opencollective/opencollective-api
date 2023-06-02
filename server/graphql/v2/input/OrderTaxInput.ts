import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLCountryISO } from '../enum';
import { GraphQLOrderTaxType } from '../enum/OrderTaxType';

import { GraphQLAmountInput } from './AmountInput';

export const GraphQLOrderTaxInput = new GraphQLInputObjectType({
  name: 'OrderTaxInput',
  description: 'Input to set taxes for an order',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(GraphQLOrderTaxType),
    },
    amount: {
      type: new GraphQLNonNull(GraphQLAmountInput),
    },
    country: {
      type: GraphQLCountryISO,
      description: 'Country of the account ordering, to know from where to apply the tax',
      // TODO: Create an issue to deprecate this field and use `order.location` instead
    },
    idNumber: {
      type: GraphQLString,
      description: 'Tax identification number, if any',
    },
  }),
});
