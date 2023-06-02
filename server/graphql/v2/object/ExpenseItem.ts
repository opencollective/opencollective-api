import express from 'express';
import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLFileInfo } from '../interface/FileInfo';
import URL from '../scalar/URL';

const GraphQLExpenseItem = new GraphQLObjectType({
  name: 'ExpenseItem',
  description: 'Fields for an expense item',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this expense item',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE_ITEM),
    },
    amount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Amount of this item',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was last updated',
    },
    incurredAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the expense took place',
    },
    description: {
      type: GraphQLString,
      description: 'A description for this item. Enforced for new items, but old expenses may not have one.',
    },
    url: {
      type: URL,
      resolve(item, _, req: express.Request): string | undefined {
        if (getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, item.ExpenseId)) {
          return item.url;
        }
      },
    },
    file: {
      type: GraphQLFileInfo,
      description: 'The file associated with this item (if any)',
      resolve(item, _, req: express.Request): string | undefined {
        if (item.url && getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, item.ExpenseId)) {
          return req.loaders.UploadedFile.byUrl.load(item.url);
        }
      },
    },
  }),
});

export default GraphQLExpenseItem;
