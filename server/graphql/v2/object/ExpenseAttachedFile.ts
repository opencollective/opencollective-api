import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { ExpenseAttachedFile } from '../../../models';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLFileInfo } from '../interface/FileInfo';
import URL from '../scalar/URL';

const GraphQLExpenseAttachedFile = new GraphQLObjectType({
  name: 'ExpenseAttachedFile',
  description: "Fields for an expense's attached file",
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this file',
      deprecationReason: '2026-02-25: use publicId',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE_ATTACHED_FILE),
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${ExpenseAttachedFile.nanoIdPrefix}_xxxxxxxx)`,
    },
    url: {
      type: URL,
      async resolve(item, _, req: express.Request): Promise<string | undefined> {
        if (item.url && getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, item.ExpenseId)) {
          const uploadedFile = await req.loaders.UploadedFile.byUrl.load(item.url);
          return uploadedFile?.url || item.url;
        }
      },
    },
    info: {
      type: GraphQLFileInfo,
      description: 'The file info associated with this item (if any)',
      resolve(item, _, req: express.Request) {
        // Permission is checked in the parent resolver
        if (item.url) {
          return req.loaders.UploadedFile.byUrl.load(item.url);
        }
      },
    },
    name: {
      type: GraphQLString,
      description: 'The original filename',
      deprecationReason: '2023-01-23: We\'re moving this field to "file.name"',
      async resolve(item, _, req: express.Request): Promise<string | undefined> {
        // Permission is checked in the parent resolver
        if (item.url) {
          const file = await req.loaders.UploadedFile.byUrl.load(item.url);
          if (file) {
            return file.fileName;
          }
        }
      },
    },
  }),
});

export default GraphQLExpenseAttachedFile;
