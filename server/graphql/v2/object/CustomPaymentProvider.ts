import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';

export const GraphQLCustomPaymentProvider = new GraphQLObjectType({
  name: 'CustomPaymentProvider',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    type: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'CustomPaymentProviderType',
          values: {
            BANK_TRANSFER: { value: 'BANK_TRANSFER' },
            OTHER: { value: 'OTHER' },
          },
        }),
      ),
    },
    name: { type: new GraphQLNonNull(GraphQLNonEmptyString) },
    instructions: { type: GraphQLString },
    icon: { type: GraphQLString },
    accountDetails: { type: GraphQLJSON },
  },
});
