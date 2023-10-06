import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLAccount } from '../interface/Account';

export const GraphQLMergeAccountsResponse = new GraphQLObjectType({
  name: 'MergeAccountsResponse',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'The resulting account',
    },
    message: {
      type: GraphQLString,
      description: 'A message to display to the user about the result',
    },
  }),
});
