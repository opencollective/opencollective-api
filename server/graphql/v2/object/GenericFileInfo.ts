import { GraphQLObjectType } from 'graphql';

import { fileInfoFields, GraphQLFileInfo } from '../interface/FileInfo.js';

export const GraphQLGenericFileInfo = new GraphQLObjectType({
  name: 'GenericFileInfo',
  interfaces: () => [GraphQLFileInfo],
  fields: () => ({
    ...fileInfoFields,
  }),
});
