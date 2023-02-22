import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
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
    };
  },
});
