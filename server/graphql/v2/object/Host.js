import { GraphQLObjectType, GraphQLInt } from 'graphql';

import { Account, AccountFields } from '../interface/Account';

export const Host = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [Account],
  fields: () => {
    return {
      ...AccountFields,
      totalHostedCollectives: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.getHostedCollectivesCount();
        },
      },
    };
  },
});
