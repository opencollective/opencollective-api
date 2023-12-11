import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

const GraphQLSetupIntentInput = new GraphQLInputObjectType({
  name: 'SetupIntentInput',
  description: 'A Stripe setup intent',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
      stripeAccount: {
        type: new GraphQLNonNull(GraphQLString),
      },
    };
  },
});

export default GraphQLSetupIntentInput;
