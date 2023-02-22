import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLIndividual } from '../object/Individual';

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
