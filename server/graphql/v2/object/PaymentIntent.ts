import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

const PaymentIntent = new GraphQLObjectType({
  name: 'PaymentIntent',
  description: 'A Stripe payment intent',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
      paymentIntentClientSecret: {
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

export default PaymentIntent;
