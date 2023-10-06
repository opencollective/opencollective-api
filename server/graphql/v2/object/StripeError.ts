import { GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

export const GraphQLStripeError = new GraphQLObjectType({
  name: 'StripeError',
  fields: () => {
    return {
      message: {
        type: GraphQLString,
      },
      account: {
        type: GraphQLString,
      },
      response: {
        type: GraphQLJSON,
      },
    };
  },
});
