import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import GraphQLUpdate from '../object/Update.js';

export const GraphQLUpdateCollection = new GraphQLObjectType({
  name: 'UpdateCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Updates"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLUpdate)),
      },
    };
  },
});
