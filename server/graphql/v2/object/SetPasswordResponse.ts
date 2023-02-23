import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { Individual } from '../object/Individual';

export const SetPasswordResponse = new GraphQLObjectType({
  name: 'SetPasswordResponse',
  fields: () => ({
    individual: {
      type: new GraphQLNonNull(Individual),
    },
    token: {
      type: GraphQLString,
    },
  }),
});
