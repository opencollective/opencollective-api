import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

const GraphQLSetupIntent = new GraphQLObjectType({
  name: 'SetupIntent',
  description: 'A Stripe setup intent',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
      setupIntentClientSecret: {
        type: new GraphQLNonNull(GraphQLString),
      },
      stripeAccount: {
        type: new GraphQLNonNull(GraphQLString),
      },
      stripeAccountPublishableSecret: {
        type: new GraphQLNonNull(GraphQLString),
      },
    };
  },
});

export default GraphQLSetupIntent;
