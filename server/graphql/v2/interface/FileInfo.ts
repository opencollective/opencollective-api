import { GraphQLInt, GraphQLInterfaceType, GraphQLNonNull, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityMigratedToPublicId } from '../../../lib/permalink/entity-map';
import { UploadedFile } from '../../../models';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';
import URL from '../scalar/URL';

export const fileInfoFields = {
  id: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'Unique identifier for the file',
    resolve: file => {
      if (isEntityMigratedToPublicId(EntityShortIdPrefix.UploadedFile, file.createdAt)) {
        return file.publicId;
      } else {
        return idEncode(file.id, IDENTIFIER_TYPES.UPLOADED_FILE);
      }
    },
  },
  publicId: {
    type: new GraphQLNonNull(GraphQLString),
    description: `The resource public id (ie: ${EntityShortIdPrefix.UploadedFile}_xxxxxxxx)`,
  },
  url: {
    type: new GraphQLNonNull(URL),
    description: 'URL to access the file',
  },
  name: {
    type: GraphQLString,
    description: 'Name of the file',
    resolve: file => file.fileName,
  },
  type: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'Mime type of the file',
    resolve: file => file.fileType,
  },
  size: {
    type: GraphQLInt,
    description: 'Size of the file in bytes',
    resolve: file => file.fileSize,
  },
};

export const GraphQLFileInfo = new GraphQLInterfaceType({
  name: 'FileInfo',
  description: 'Exposes information about an uploaded file (image, pdf, etc.)',
  fields: () => fileInfoFields,
  resolveType: uploadedFile => {
    if (UploadedFile.isSupportedImageMimeType(uploadedFile.fileType)) {
      return 'ImageFileInfo';
    } else {
      return 'GenericFileInfo';
    }
  },
});
