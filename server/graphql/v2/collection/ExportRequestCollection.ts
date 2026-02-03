import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLExportRequest } from '../object/ExportRequest';

export const GraphQLExportRequestCollection = new GraphQLObjectType({
  name: 'ExportRequestCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "ExportRequest"',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLExportRequest)),
    },
  }),
});
