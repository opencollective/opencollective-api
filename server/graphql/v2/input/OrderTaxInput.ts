import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { CountryISO } from '../enum';
import { OrderTaxType } from '../enum/OrderTaxType';

import { AmountInput } from './AmountInput';

export const OrderTaxInput = new GraphQLInputObjectType({
  name: 'OrderTaxInput',
  description: 'Input to set taxes for an order',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(OrderTaxType),
    },
    amount: {
      type: new GraphQLNonNull(AmountInput),
    },
    country: {
      type: CountryISO,
      description: 'Country of the account ordering, to know from where to apply the tax',
      // TODO: Create an issue to deprecate this field and use `order.location` instead
    },
    idNumber: {
      type: GraphQLString,
      description: 'Tax identification number, if any',
    },
  }),
});
