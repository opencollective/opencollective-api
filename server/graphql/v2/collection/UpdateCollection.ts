import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import GraphQLUpdate from '../object/Update';

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
