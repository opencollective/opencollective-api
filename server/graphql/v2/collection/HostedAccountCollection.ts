import { GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLAccount } from '../interface/Account';
import { CollectionFields, GraphQLCollection } from '../interface/Collection';

export const GraphQLHostedAccountCollection = new GraphQLObjectType({
  name: 'HostedAccountCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of hosted "Accounts"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLAccount),
      },
      currencies: {
        type: new GraphQLList(GraphQLString),
      },
    };
  },
});
