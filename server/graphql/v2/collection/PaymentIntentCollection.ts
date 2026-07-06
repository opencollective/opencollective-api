import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLPaymentIntent } from '../object/PaymentIntent';

export const GraphQLPaymentIntentCollection = new GraphQLObjectType({
  name: 'PaymentIntentCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of Payment Intents',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPaymentIntent))),
    },
  }),
});
