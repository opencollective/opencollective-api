import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { get } from 'lodash';

import { fileInfoFields, GraphQLFileInfo } from '../interface/FileInfo';

export const GraphQLImageFileInfo = new GraphQLObjectType({
  name: 'ImageFileInfo',
  description: 'Exposes information about an uploaded image file',
  interfaces: () => [GraphQLFileInfo],
  fields: () => ({
    ...fileInfoFields,
    width: {
      type: GraphQLInt,
      description: 'If the file is an image, this will be the width of the image in pixels',
      resolve: file => {
        return get(file.data, 'width');
      },
    },
    height: {
      type: GraphQLInt,
      description: 'If the file is an image, this will be the height of the image in pixels',
      resolve: file => {
        return get(file.data, 'height');
      },
    },
    blurHash: {
      type: GraphQLString,
      description: 'Blurhash of the image',
      resolve: file => {
        return get(file.data, 'blurHash');
      },
    },
  }),
});
