import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers.js';
import { GraphQLFileInfo } from '../interface/FileInfo.js';
import URL from '../scalar/URL.js';

const GraphQLExpenseAttachedFile = new GraphQLObjectType({
  name: 'ExpenseAttachedFile',
  description: "Fields for an expense's attached file",
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this file',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE_ATTACHED_FILE),
    },
    url: {
      type: URL,
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
