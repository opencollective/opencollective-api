import { GraphQLObjectType } from 'graphql';

import { isSupportedImageMimeType } from '../../../lib/images';
import { FileInfo, fileInfoFields } from '../interface/FileInfo';

export const GenericFileInfo = new GraphQLObjectType({
  name: 'GenericFileInfo',
  interfaces: () => [FileInfo],
  isTypeOf: file => !isSupportedImageMimeType(file.fileType),
  fields: () => ({
    ...fileInfoFields,
  }),
});
