import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { Account } from '../interface/Account';

export const MergeAccountsResponse = new GraphQLObjectType({
  name: 'MergeAccountsResponse',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(Account),
      description: 'The resulting account',
    },
    message: {
      type: GraphQLString,
      description: 'A message to display to the user about the result',
    },
  }),
});
