import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLOrder } from '../object/Order';

export const GraphQLOrderCollection = new GraphQLObjectType({
  name: 'OrderCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Orders"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLOrder),
      },
      createdByUsers: {
        type: new GraphQLList(GraphQLAccount),
        description: 'The accounts that created the orders in this collection, regardless of pagination',
      },
    };
  },
});
