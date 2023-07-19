import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLIndividual } from '../object/Individual.js';

export const GraphQLSetPasswordResponse = new GraphQLObjectType({
  name: 'SetPasswordResponse',
  fields: () => ({
    individual: {
      type: new GraphQLNonNull(GraphQLIndividual),
    },
    token: {
      type: GraphQLString,
    },
  }),
});
