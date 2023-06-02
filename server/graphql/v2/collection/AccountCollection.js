import { GraphQLList, GraphQLObjectType } from 'graphql';

import { GraphQLAccount } from '../interface/Account';
import { CollectionFields, GraphQLCollection } from '../interface/Collection';

export const GraphQLAccountCollection = new GraphQLObjectType({
  name: 'AccountCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Accounts"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLAccount),
      },
    };
  },
});
