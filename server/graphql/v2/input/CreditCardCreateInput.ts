import { GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

export const GraphQLCreditCardCreateInput = new GraphQLInputObjectType({
  name: 'CreditCardCreateInput',
  fields: () => ({
    token: { type: new GraphQLNonNull(GraphQLString) },
    brand: { type: GraphQLString, deprecationReason: '2022-11-22: the `token` parameter is sufficient' },
    country: { type: GraphQLString, deprecationReason: '2022-11-22: the `token` parameter is sufficient' },
    expMonth: { type: GraphQLInt, deprecationReason: '2022-11-22: the `token` parameter is sufficient' },
    expYear: { type: GraphQLInt, deprecationReason: '2022-11-22: the `token` parameter is sufficient' },
    fullName: { type: GraphQLString, deprecationReason: '2022-11-22: the field was not used since 2017' },
    funding: { type: GraphQLString, deprecationReason: '2022-11-22: the `token` parameter is sufficient' },
    zip: { type: GraphQLString },
  }),
});
