import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

const getFields = () => ({
  id: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'The ID of the Stripe payment intent',
  },
  paymentIntentClientSecret: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'The client secret of the Stripe payment intent',
  },
  stripeAccount: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'The associated Stripe account ID',
  },
  stripeAccountPublishableSecret: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'The publishable secret of the associated Stripe account',
  },
});

const GraphQLStripePaymentIntent = new GraphQLObjectType({
  name: 'StripePaymentIntent',
  description: 'A Stripe payment intent',
  fields: getFields,
});

// TODO(#8851): remove this legacy type
export const LegacyGraphQLPaymentIntent = new GraphQLObjectType({
  name: 'PaymentIntent',
  description: 'A Stripe payment intent (deprecated, use StripePaymentIntent)',
  fields: getFields,
});

export default GraphQLStripePaymentIntent;
